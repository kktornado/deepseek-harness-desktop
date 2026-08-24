/**
 * Desktop shell plugin — runs inside the harness subprocess (web profile).
 *
 * Provides host-plane services the in-page settings UI consumes:
 *   GET  /desktop-shell/settings      — current shell settings (mirror file)
 *   POST /desktop-shell/settings      — patch shell settings + write mirror
 *   POST /desktop-shell/apply         — request the Electron main process to
 *                                       re-apply settings (engine/version/LAN);
 *                                       implemented as a sentinel file that the
 *                                       main process polls every two seconds.
 *
 * Settings are persisted to `<userData>/engine/desktop-shell.json` so the
 * plugin (running inside the harness subprocess) can be the source of truth
 * without a reverse IPC channel into Electron's main process. The Electron
 * shell keeps its own `engine.state.json` in sync by polling the file.
 * @module desktop-shell
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'desktop-shell'

/** The web profile always mounts the webserver row before later inserts. */
export const inject = ['webServer']

/** @returns an empty, dependency-free config schema. */
export const Config = undefined

const SETTINGS_KEYS = [
  'channel',
  'port',
  'autoUpdate',
  'shortcut',
  'lan',
  'lanHost',
  'trustedHosts',
]

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  writeFileSync(path, JSON.stringify(value, null, 2))
  try {
    unlinkSync(tmp)
  } catch {
    // Best-effort: tmp cleanup is non-essential.
  }
}

function createSettingsStore(dir) {
  const file = join(dir, 'desktop-shell.json')
  const applyReq = join(dir, 'apply-request.json')

  function load() {
    const stored = readJson(file)
    if (stored !== undefined && typeof stored === 'object') return stored
    return {}
  }

  return {
    get() {
      return load()
    },
    patch(partial) {
      const next = { ...load(), ...partial }
      atomicWriteJson(file, next)
      return next
    },
    requestApply(reason) {
      atomicWriteJson(applyReq, { at: Date.now(), reason: reason ?? 'manual' })
    },
  }
}

/** Read JSON body of a Node http request as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ userDataDir?: string, settingsDir?: string }} [options]
 */
export function apply(ctx, options = {}) {
  // Settings directory: the Electron main process passes its userData dir via
  // `DESKTOP_SHELL_USERDATA` (a `DSH_*` name would be scrubbed by the harness's
  // subprocess env policy) and our engine writes state.json into
  // `<userData>/engine`. Fall back to the working directory when unset.
  const settingsDir = options.settingsDir
    ?? join(process.env.DESKTOP_SHELL_USERDATA ?? process.cwd(), 'engine')
  const settings = createSettingsStore(settingsDir)

  function jsonResponse(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const disposeGetSettings = ctx.webServer.register({
    kind: 'exact',
    path: '/desktop-shell/settings',
    handler: async (req, res) => {
      if (req.method === 'POST') {
        let body
        try {
          const text = await readBody(req)
          body = text.length === 0 ? {} : JSON.parse(text)
        } catch (error) {
          return jsonResponse(res, 400, { error: `invalid JSON: ${String(error)}` })
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return jsonResponse(res, 400, { error: 'body must be a JSON object' })
        }
        const patch = {}
        for (const key of SETTINGS_KEYS) {
          if (Object.hasOwn(body, key)) patch[key] = body[key]
        }
        const next = settings.patch(patch)
        // Do NOT requestApply here: saving a setting must not restart the
        // harness on every checkbox/keystroke. The client decides when a
        // restart is needed and calls POST /desktop-shell/apply explicitly
        // (its "立即重启服务" button), which writes the apply sentinel.
        return jsonResponse(res, 200, next)
      }
      return jsonResponse(res, 200, settings.get())
    },
  })
  const disposeApply = ctx.webServer.register({
    kind: 'exact',
    path: '/desktop-shell/apply',
    handler: async (req, res) => {
      let reason = 'manual'
      try {
        const text = await readBody(req)
        if (text.length > 0) reason = JSON.parse(text).reason ?? reason
      }
      catch {
        // ignore parse errors; use default reason
      }
      settings.requestApply(reason)
      return jsonResponse(res, 200, { ok: true, requestedAt: Date.now(), reason })
    },
  })

  return () => {
    disposeGetSettings()
    disposeApply()
  }
}