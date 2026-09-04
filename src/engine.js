/**
 * Engine manager — owns the bundled-node harness subprocess and the pnpm-based
 * version store under `userData/engine`.
 *
 * Layout:
 *   engine/state.json                  persisted settings + current version
 *   engine/versions/<version>/         one self-contained pnpm tree per version
 *     node_modules/@deepseek-ai/dsh/   the engine
 *     node_modules/@dsh-desktop/shell/ the desktop shell plugin (copied post-install)
 *     dsh-desktop.patch.yml            generated loader patch referencing the plugin
 *
 * The plugin is copied into the tree after every install because `pnpm install`
 * prunes extraneous top-level packages; a `file:` dependency is deliberately
 * avoided so pnpm never needs to read through the packaged asar archive.
 * @module engine
 */

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')

const DSH_PACKAGE = '@deepseek-ai/dsh'
const PLUGIN_PACKAGE = '@dsh-desktop/shell'
// npmmirror (Alibaba global CDN) is preferred: it hosts the same packages and
// serves tarballs faster than the official registry in most regions; the
// official registry is the fallback when the mirror is unreachable.
const REGISTRIES = [
  'https://registry.npmmirror.com/@deepseek-ai/dsh',
  'https://registry.npmjs.org/@deepseek-ai/dsh',
]
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json'

/** Default settings for a fresh install. */
const DEFAULT_STATE = {
  current: undefined,
  channel: 'next',
  port: 3080,
  autoUpdate: false,
  shortcut: 'Ctrl+Shift+D',
  lan: false,
  lanHost: '',
  trustedHosts: [],
}

/** Simple semver-ish comparison supporting `x.y.z[-rc.N]`. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/.exec(v)
    return m === null
      ? [0, 0, 0, 0]
      : [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[4])]
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 4; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/** @param {string} dir */
function pathExists(dir) {
  try {
    fs.accessSync(dir)
    return true
  } catch {
    return false
  }
}

/** @param {string} dir */
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

class EngineManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.userData - Electron userData dir.
   * @param {string} options.projectRoot - repository root in dev (for the plugin source).
   * @param {string} options.resources - app resources dir when packaged.
   * @param {object} options.log - logger with a `.log(message)` method.
   */
  constructor({ userData, projectRoot, resources, log }) {
    super()
    this.userData = userData
    this.root = path.join(userData, 'engine')
    this.versionsRoot = path.join(this.root, 'versions')
    this.dshHome = path.join(userData, 'dshhome')
    this.projectRoot = projectRoot
    this.resources = resources
    this.log = log
    this.statePath = path.join(this.root, 'state.json')
    this.state = this.loadState()
    this.child = undefined
    // The authenticated browser URL printed by the running harness
    // (`dsh web: <url>`), carrying the per-process launch token. Newer engine
    // versions mint the token at every spawn and refuse any browser request
    // that does not carry it or a cookie issued from it; the desktop window
    // must load this URL, not the bare origin.
    this.authenticatedUrl = undefined
  }

  // ── state ────────────────────────────────────────────────────────────────

  loadState() {
    let stored = {}
    try {
      stored = JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
    } catch {
      stored = {}
    }
    // Validate critical fields; bad data falls back to the default. Older
    // builds stored `port: -1` (e.g. from a typo'd user input) which the
    // harness then rejected with `--port must be a number` and the spawn
    // loop gave up after three restarts.
    const merged = { ...DEFAULT_STATE, ...stored }
    if (!Number.isInteger(merged.port) || merged.port < 1 || merged.port > 65535) {
      merged.port = DEFAULT_STATE.port
    }
    if (merged.channel !== 'next' && merged.channel !== 'latest') {
      merged.channel = DEFAULT_STATE.channel
    }
    return merged
  }

  saveState() {
    mkdirp(this.root)
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2))
  }

  /**
   * Merge a settings patch and persist it.
   * @param {Partial<typeof DEFAULT_STATE>} patch - keys to update.
   */
  updateState(patch) {
    this.state = { ...this.state, ...patch }
    this.saveState()
  }

  // ── runtimes ─────────────────────────────────────────────────────────────

  /**
   * Resolve the bundled Node executable. Packaged builds ship `resources/node`
   * (extraResources); dev falls back to `runtime/` then the system PATH.
   * @returns {string} the node binary path.
   */
  nodeBinary() {
    if (this.resources) {
      const candidate = path.join(this.resources, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
      if (pathExists(candidate)) return candidate
    }
    const dev = path.join(this.projectRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node')
    if (pathExists(dev)) return dev
    return process.platform === 'win32' ? 'node.exe' : 'node'
  }

  /**
   * Resolve the pnpm invocation. Bundled installs carry pnpm at
   * `resources/pnpm` (extraResources) / dev `runtime/pnpm`; both are a pnpm
   * package tree whose `bin/pnpm.cjs` runs under the bundled node. A system
   * `pnpm` on PATH is the dev fallback.
   * @returns {{ bin: string, args: string[] }}
   */
  pnpmInvocation() {
    for (const base of [this.resources && path.join(this.resources, 'pnpm'), path.join(this.projectRoot, 'runtime', 'pnpm')]) {
      if (!base || !pathExists(base)) continue
      const cjs = path.join(base, 'bin', 'pnpm.cjs')
      if (pathExists(cjs)) return { bin: this.nodeBinary(), args: [cjs] }
    }
    return { bin: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] }
  }

  /**
   * Write the pnpm-workspace.yaml used for every engine install. It approves
   * the build scripts of the non-network native packages (their scripts are
   * fast and offline), leaves node-pty unapproved (its prebuild downloads from
   * GitHub releases, which hangs where GitHub is blocked) and disables the
   * minimumReleaseAge supply-chain gate (freshly published release-candidate
   * packages would otherwise be rejected). strictDepBuilds is off so the
   * unapproved node-pty build is a warning, not an install failure. The hoisted
   * linker is forced via the install CLI flag (a node-linker field here would
   * be dropped when pnpm rewrites this file).
   * @param {string} dir - engine version tree root.
   */
  writePnpmWorkspace(dir) {
    const yaml = [
      'allowBuilds:',
      '  koffi: true',
      '  protobufjs: true',
      '  \'@google/genai\': true',
      '  \'@deepseek-ai/dsh-subprocess-local\': true',
      'minimumReleaseAge: 0',
      'strictDepBuilds: false',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), yaml)
  }

  // ── version store ────────────────────────────────────────────────────────

  versionDir(version) {
    return path.join(this.versionsRoot, version)
  }

  isInstalled(version) {
    return pathExists(path.join(this.versionDir(version), 'node_modules', DSH_PACKAGE, 'package.json'))
  }

  /**
   * Whether an installed engine tree is fully usable. Beyond the dsh package
   * existing, dsh-app-boot must resolve js-yaml — pnpm's isolated store links
   * per-package deps with per-package symlinks, and a copied tree that lost
   * those links (e.g. fs.cpSync of a pnpm tree on Windows) fails to boot with
   * ERR_MODULE_NOT_FOUND. A tree that fails here must be removed and rebuilt
   * with pnpm.
   * @param {string} version - engine version.
   * @returns {boolean}
   */
  verifyInstalled(version) {
    const root = this.versionDir(version)
    if (!pathExists(path.join(root, 'node_modules', DSH_PACKAGE, 'package.json'))) return false
    const boot = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    if (!pathExists(path.join(boot, 'package.json'))) return false
    // dsh-app-boot imports js-yaml directly; the pnpm per-package link or a
    // hoisted top-level copy must be present for ESM to resolve it.
    return pathExists(path.join(boot, 'node_modules', 'js-yaml'))
      || pathExists(path.join(root, 'node_modules', 'js-yaml'))
  }

  /**
   * Delete installed trees that fail verifyInstalled (broken copies from an
   * earlier seed-based install, interrupted installs). Broken versions would
   * otherwise be picked as the newest installed and crash on boot.
   * @returns {string[]} the versions removed.
   */
  purgeBrokenVersions() {
    if (!pathExists(this.versionsRoot)) return []
    const removed = []
    for (const name of fs.readdirSync(this.versionsRoot)) {
      if (this.isInstalled(name) && !this.verifyInstalled(name)) {
        fs.rmSync(this.versionDir(name), { recursive: true, force: true })
        removed.push(name)
      }
    }
    return removed
  }

  installedVersions() {
    if (!pathExists(this.versionsRoot)) return []
    return fs.readdirSync(this.versionsRoot)
      .filter((name) => this.isInstalled(name))
      .sort(compareVersions)
      .reverse()
  }

  /**
   * Whether an engine version expects the versioned (v1) credentials
   * document layout (`version: 1` + `refs:`) or the pre-release flat layout
   * (bare `KEY: value`). Inferred from the installed package's
   * dsh-credentials-local source: the versioned parser requires a
   * `version` field and a `DOCUMENT_VERSION` constant; the flat parser has
   * neither. A not-yet-installed version returns undefined.
   * @param {string} version - engine version.
   * @returns {'versioned' | 'flat' | undefined}
   */
  credentialFormat(version) {
    const root = this.versionDir(version)
    const glob = path.join(root, 'node_modules', '.pnpm', '@deepseek-ai+dsh-credential*', 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js')
    // Simple read of the first matching credentials-local lib file.
    let lib = undefined
    if (pathExists(root)) {
      const pnpmDir = path.join(root, 'node_modules', '.pnpm')
      if (pathExists(pnpmDir)) {
        for (const entry of fs.readdirSync(pnpmDir)) {
          if (!entry.startsWith('@deepseek-ai+dsh-credential')) continue
          const candidate = path.join(pnpmDir, entry, 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js')
          if (pathExists(candidate)) { lib = candidate; break }
        }
      }
    }
    if (lib === undefined) return undefined
    const source = fs.readFileSync(lib, 'utf8')
    return source.includes('DOCUMENT_VERSION') && source.includes('"version" in fields') ? 'versioned' : 'flat'
  }

  /**
   * The credentials document's current layout on disk. Reads
   * `$DSH_HOME/.credentials.yaml` and returns 'versioned' when it declares a
   * `version` key, 'flat' when it is a bare mapping, or undefined when the
   * file is absent.
   * @returns {'versioned' | 'flat' | undefined}
   */
  currentCredentialFormat() {
    const file = path.join(this.dshHome, '.credentials.yaml')
    if (!pathExists(file)) return undefined
    try {
      const text = fs.readFileSync(file, 'utf8')
      return /^\s*version\s*:/m.test(text) ? 'versioned' : 'flat'
    } catch {
      return undefined
    }
  }

  /**
   * Whether `version` can be switched to given the current credentials
   * document layout. A versioned engine requires the versioned layout; a
   * flat engine requires the flat layout. Unknown target or absent
   * credentials file are treated as compatible.
   * @param {string} version - target engine version.
   * @returns {boolean}
   */
  isCredentialCompatible(version) {
    const target = this.credentialFormat(version)
    const current = this.currentCredentialFormat()
    if (target === undefined || current === undefined) return true
    return target === current
  }

  pluginSourceDir() {
    // Packaged: resources/desktop-shell (extraResources, unpacked). Dev: src/desktop-shell.
    if (this.resources) {
      const packaged = path.join(this.resources, 'desktop-shell')
      if (pathExists(packaged)) return packaged
    }
    return path.join(this.projectRoot, 'src', 'desktop-shell')
  }

  pluginDir(version) {
    return path.join(this.versionDir(version), 'node_modules', PLUGIN_PACKAGE)
  }

  dshBin(version) {
    return path.join(this.versionDir(version), 'node_modules', DSH_PACKAGE, 'lib', 'bin.js')
  }

  patchPath(version) {
    return path.join(this.versionDir(version), 'dsh-desktop.patch.yml')
  }

  /**
   * Flat module-fallback link so the harness resolves `@dsh-desktop/shell` as
   * a bare package name. The harness's `client-modules` resolves a plugin
   * through `createRequire(ctx.baseUrl)`; baseUrl is a profile config dir and
   * Node's parent walk reaches `$DSH_HOME/profiles/node_modules` (the same
   * flat fallback the harness maintains via healProfilesModuleFallback for
   * every package in the dsh closure). One link per plugin name is enough:
   * Node follows symlinks to the real package, which resolves its own deps
   * from its real directory.
   */
  pluginFallbackLink() {
    return path.join(this.dshHome, 'profiles', 'node_modules', PLUGIN_PACKAGE)
  }

  writePatch(version) {
    // Single bare package-name entry: the loader imports `@dsh-desktop/shell`
    // (resolving through the flat module fallback under
    // `$DSH_HOME/profiles/node_modules`), which carries both the host-side
    // apply (`lib/index.mjs`) and the `dsh.client` declaration the harness
    // uses to serve `lib/client.js` to the browser. A file:// URL would make
    // the host import the browser bundle directly, which throws
    // (`window is not defined`). The `name` field is mandatory — an entry
    // with only an `id` imports `undefined`.
    const patch = [
      '# Generated by DeepSeek Harness Desktop — do not edit.',
      '- insert:',
      "    - id: '@dsh-desktop/shell'",
      "      name: '@dsh-desktop/shell'",
      '',
    ].join('\n')
    fs.writeFileSync(this.patchPath(version), patch)
  }

  copyPlugin(version) {
    const source = this.pluginSourceDir()
    if (!pathExists(source)) throw new Error(`desktop-shell plugin source missing: ${source}`)

    // Copy into the version tree so the installed engine's own node_modules
    // tree has the package physically present.
    const target = this.pluginDir(version)
    mkdirp(path.dirname(target))
    if (pathExists(target)) fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(source, target, { recursive: true })

    // Point the flat module fallback at that copy so bare-name resolution
    // (loader import + client-modules package.json scan) finds it. A junction
    // needs no privileges on Windows; a directory symlink elsewhere.
    const link = this.pluginFallbackLink()
    mkdirp(path.dirname(link))
    try {
      if (process.platform === 'win32') {
        // rmSync with force deletes a stale junction too: a dangling junction
        // (target tree removed) makes existsSync false yet leaves the link
        // name occupied, which would make symlinkSync throw EEXIST.
        fs.rmSync(link, { recursive: true, force: true })
        fs.symlinkSync(target, link, 'junction')
      } else {
        if (fs.lstatSync(link, { throwIfNoEntry: false }) !== undefined) fs.unlinkSync(link)
        fs.symlinkSync(target, link, 'dir')
      }
    } catch (error) {
      throw new Error(`desktop-shell plugin fallback link failed: ${String(error)}`)
    }
  }

  /**
   * Install one engine version into its own tree with pnpm. The engine is
   * never bundled with the app: first launch needs the network once, then the
   * installed tree persists under userData and is used offline thereafter.
   * The version tree starts clean (a broken or partial previous tree is
   * removed), and the finished tree must pass verifyInstalled or the install
   * is treated as failed. Then copy the plugin in and write the loader patch.
   * @param {string} version - exact npm version of `@deepseek-ai/dsh`.
   * @param {(line: string) => void} [onOutput] - streaming install output.
   */
  async install(version, onOutput) {
    const dir = this.versionDir(version)
    if (pathExists(dir)) fs.rmSync(dir, { recursive: true, force: true })
    mkdirp(dir)
    const manifest = {
      private: true,
      dependencies: { [DSH_PACKAGE]: version },
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
    this.writePnpmWorkspace(dir)
    const pnpm = this.pnpmInvocation()
    const args = [
      ...pnpm.args,
      'install', '--prod', '--no-frozen-lockfile',
      '--config.confirmModulesPurge=false',
      '--node-linker=hoisted',
      '--loglevel=error',
    ]
    const env = { ...process.env, CI: 'true' }
    if (this.registryBase !== undefined) env.npm_config_registry = `${this.registryBase}/`
    await this.runInstall(pnpm.bin, args, dir, env, version, onOutput, 180000)
    if (!this.verifyInstalled(version)) {
      throw new Error(`engine install for ${version} produced an incomplete tree`)
    }
    this.copyPlugin(version)
    this.writePatch(version)
  }

  /**
   * Run a package-manager subprocess in a version tree, streaming output.
   * @private
   * @param {number} [timeoutMs] - kill the child and reject after this long.
   */
  runInstall(bin, args, cwd, env, version, onOutput, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: bin.endsWith('.cmd'),
      })
      let output = ''
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        child.kill()
        finish(reject, new Error(`install exceeded ${timeoutMs} ms`))
      }, timeoutMs)
      const sink = (chunk) => {
        const text = chunk.toString()
        output += text
        if (onOutput) onOutput(text)
      }
      child.stdout.on('data', sink)
      child.stderr.on('data', sink)
      child.on('error', (error) => finish(reject, error))
      child.on('close', (code) => {
        if (code === 0) {
          finish(resolve)
        } else {
          finish(reject, new Error(`pnpm for ${version} failed (code ${code}):\n${output.slice(-2000)}`))
        }
      })
    })
  }

  // ── registry ─────────────────────────────────────────────────────────────

  /**
   * Fetch engine release metadata (dist-tags + versions) from the npm registry.
   * All candidate registries are raced; the first to respond wins and is used
   * for the subsequent install. On the public internet this favours the
   * official registry; in regions with a fast mirror it favours the mirror.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ latest: string, next: string, versions: string[], registry: string }>}
   * @throws when every candidate fails.
   */
  async registry(options = {}) {
    const timeoutMs = options.timeoutMs ?? 8000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const results = await Promise.allSettled(
        REGISTRIES.map(async (endpoint) => {
          const res = await fetch(endpoint, {
            headers: { accept: REGISTRY_ACCEPT },
            signal: controller.signal,
          })
          if (!res.ok) throw new Error(`registry responded ${res.status}`)
          return { endpoint, data: await res.json() }
        }),
      )
      const settled = results.find((result) => result.status === 'fulfilled')
      if (settled === undefined) {
        const reasons = results.map((result) => result.reason).join('; ')
        throw new Error(reasons)
      }
      const { endpoint, data } = settled.value
      const distTags = data['dist-tags'] ?? {}
      const versions = Object.keys(data.versions ?? {})
      this.registryBase = new URL(endpoint).origin
      return {
        latest: distTags.latest,
        next: distTags.next,
        versions: versions.sort(compareVersions).reverse(),
        registry: this.registryBase,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Resolve the version to run: explicit current, else the channel tag.
   * @param {string} [fallback] - current state value.
   * @returns {Promise<string | undefined>}
   */
  async resolveTarget(fallback = this.state.current) {
    if (fallback !== undefined && this.isInstalled(fallback)) return fallback
    try {
      const info = await this.registry()
      const target = info[this.state.channel]
      return target !== undefined && info.versions.includes(target) ? target : undefined
    } catch {
      return undefined
    }
  }

  // ── process ──────────────────────────────────────────────────────────────

  /**
   * Spawn the harness web subprocess for `version`.
   * @param {string} version - the installed engine version to run.
   * @returns {import('node:child_process').ChildProcess}
   */
  spawnWeb(version) {
    // Re-copy the desktop-shell plugin (host + client faces) and regenerate
    // the loader patch before every spawn. `install()` runs copyPlugin once,
    // but the plugin bundle can change between engine installs; without this,
    // an already-installed engine keeps serving a stale `lib/client.js` to
    // the harness (e.g. the in-harness settings panel stays on the old UI
    // until the engine is reinstalled).
    if (this.isInstalled(version)) {
      this.copyPlugin(version)
      this.writePatch(version)
    }
    const args = [
      this.dshBin(version),
      // `--profile web --patch` is the launcher-level form: the published rc.8
      // web alias does not carry its own `--patch` yet (master added it).
      '--profile', 'web',
      '--patch', this.patchPath(version),
      '--no-open',
      '--port', String(this.state.port),
    ]
    if (this.state.lan && this.state.lanHost) {
      args.push('--host', this.state.lanHost)
      for (const host of this.state.trustedHosts) args.push('--trusted-host', host)
    }
    const child = spawn(this.nodeBinary(), args, {
      cwd: this.versionDir(version),
      env: {
        ...process.env,
        DSH_HOME: this.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        // The harness subprocess needs to know the Electron userData dir so
        // the desktop-shell plugin can share `engine/desktop-shell.json`.
        // A `DSH_*` name would be scrubbed by the harness's subprocess env
        // policy, so this uses a neutral prefix.
        DESKTOP_SHELL_USERDATA: this.userData,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    let stdoutBuffer = ''
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      let newlineIndex
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        this.handleEngineLine(version, line)
      }
    })
    child.stdout.on('end', () => {
      if (stdoutBuffer !== '') this.handleEngineLine(version, stdoutBuffer)
      stdoutBuffer = ''
    })
    child.stderr.on('data', (chunk) => this.log.log(`[engine:${version}:err] ${chunk.toString().trimEnd()}`))
    child.on('exit', (code, signal) => this.emit('exit', { code, signal, version }))
    this.child = child
    return child
  }

  /**
   * Log one harness stdout line and watch for the readiness signal.
   * `dsh web` prints its authenticated URL (`dsh web: <url>`, the launch-token
   * form of the root origin) once the Loader tree settles and the server is
   * listening; supervisors that hand the URL to a browser use that line as the
   * readiness signal. Each process mints a fresh token, so the captured URL
   * changes on every spawn and is the only way to open an authenticated window.
   * Older engines print the bare origin — the same pattern matches either.
   * @param {string} version - the running engine version.
   * @param {string} line - one stdout line without its trailing newline.
   */
  handleEngineLine(version, line) {
    const trimmed = line.trimEnd()
    if (trimmed !== '') this.log.log(`[engine:${version}] ${trimmed}`)
    const match = /^dsh web: (https?:\/\/\S+)/u.exec(trimmed)
    if (match === null) return
    const url = match[1]
    if (this.authenticatedUrl !== url) {
      this.authenticatedUrl = url
      this.emit('url', url)
    }
  }

  /** Stop the running harness subprocess and its process tree. */
  async stopWeb() {
    const child = this.child
    this.child = undefined
    this.authenticatedUrl = undefined
    if (child === undefined) return
    if (process.platform === 'win32' && child.pid !== undefined) {
      await new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      })
      // taskkill is async: the process tree may still hold the listen socket
      // for a few hundred ms after the callback fires. Wait for the port to
      // actually free so a follow-up spawn does not hit EADDRINUSE.
      await this.waitForPortFree()
    } else if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch { /* already gone */ }
          resolve()
        }, 3000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
  }

  /**
   * Poll until the configured loopback port no longer accepts connections
   * (or a short deadline elapses). Avoids racing the OS socket teardown when
   * a freshly killed harness is immediately respawned on the same port.
   * @param {number} [deadlineMs]
   */
  async waitForPortFree(deadlineMs = 3000) {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 300)
        const res = await fetch(`http://127.0.0.1:${this.state.port}/`, { signal: controller.signal })
        clearTimeout(timer)
        await res.arrayBuffer()
        // Still reachable — keep waiting.
        await new Promise((r) => setTimeout(r, 150))
        continue
      } catch {
        // Connection refused / timeout → the port is free.
        return
      }
    }
  }

  /**
   * Health-check a harness instance on the loopback port.
   * Uses the authenticated URL when this process has one, so the check passes
   * through the launch-token exchange; a bare-origin probe of a newer engine
   * answers 401 with the auth message, which still proves a harness owns the
   * port (used to distinguish "harness running" from "unrelated program").
   * @param {number} port - port to probe.
   * @returns {Promise<{ ok: boolean, isHarness: boolean }>}
   */
  async healthCheck(port = this.state.port) {
    try {
      const url = this.authenticatedUrl !== undefined
        ? this.authenticatedUrl
        : `http://127.0.0.1:${port}/`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(1500),
      })
      const body = await res.text()
      const isHarness = body.includes('__DSH_BOOT__') || body.includes('dsh web authentication required')
      return { ok: res.ok || res.status === 401, isHarness }
    } catch {
      return { ok: false, isHarness: false }
    }
  }
}

module.exports = { EngineManager, compareVersions }