/**
 * Main process — owns the harness UI window, the engine subprocess lifecycle
 * (install/spawn/heal/stop), the tray, the global shortcut, diagnostics,
 * and shell auto-update. All shell settings + live stats are exposed
 * through the in-harness `desktop-shell` plugin and rendered via the
 * harness slot system, so there is no separate Electron console window.
 * @module main
 */

'use strict'

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, shell, dialog, nativeImage,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { createLogger } = require('./logger')
const { EngineManager } = require('./engine')

const PROJECT_ROOT = path.join(__dirname, '..')
const RESOURCES = app.isPackaged ? process.resourcesPath : null
const ICON_PATH = path.join(PROJECT_ROOT, 'build', 'icon.png')

// Isolated-data-dir override for tests; packaged builds never set it.
if (process.env.DSH_DESKTOP_USERDATA) app.setPath('userData', process.env.DSH_DESKTOP_USERDATA)
if (process.platform === 'win32') app.setAppUserModelId('com.deepseek.dsh-desktop')

// Localhost-only DevTools protocol for shell diagnostics and E2E verification.
app.commandLine.appendSwitch('remote-debugging-port', '9222')

const RESTART_MAX_ATTEMPTS = 3
const RESTART_BACKOFF_MS = 2000
const SHELL_POLL_MS = 2000

const SHELL_SETTINGS_FILE = 'desktop-shell.json'
const SHELL_APPLY_FILE = 'apply-request.json'

let logger = undefined
let engine = undefined
let uiWindow = undefined
let splashWindow = undefined
let tray = undefined
let autoUpdater = undefined

let quitting = false
let intentionalStop = false
let restartInProgress = false
let startingService = false
let serviceStartedOk = false
let restartAttempts = 0
let restartTimer = undefined
let registryCache = undefined

/** Broadcast state pushed to every renderer. */
const state = {
  engineVersion: undefined,
  latestVersion: undefined,
  updateAvailable: false,
  channel: 'next',
  port: 3080,
  autoUpdate: false,
  shortcut: 'Ctrl+Shift+D',
  lan: false,
  lanHost: '',
  trustedHosts: [],
  serviceRunning: false,
  serviceUrl: undefined,
  error: undefined,
  installing: undefined,
  pendingUpdate: undefined,
  availableVersions: [],
  runtimeLine: undefined,
  shellVersion: app.getVersion(),
  shellUpdateAvailable: false,
}

function log(message) {
  logger?.log(message)
  sendSplashStatus(message)
}

function pushState() {
  if (uiWindow && !uiWindow.isDestroyed()) uiWindow.webContents.send('dsh:state', state)
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('dsh:splash:state', state)
}

/**
 * Push a status line + progress percentage into the splash window.
 * Status is buffered so a message sent before the splash page finished
 * loading is replayed once the renderer is ready (the first status after
 * ensureSplash used to be lost, leaving a static "正在启动…" page).
 * @param {string} message
 * @param {number} [progress] - 0..100, or undefined for indeterminate.
 */
function sendSplashStatus(message, progress) {
  pendingSplashStatus = { message, progress, error: state.error }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('dsh:splash:status', pendingSplashStatus)
  }
}

let pendingSplashStatus = undefined

/** Dark splash page with a progress bar shown while the app boots. */
const SPLASH_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; padding: 0; height: 100%; background: #12161c; color: #e6e9ef; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
    .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 20px; padding: 24px; box-sizing: border-box; text-align: center; }
    h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.02em; }
    .sub { font-size: 13px; color: #9aa4b2; max-width: 360px; line-height: 1.5; }
    .track { width: 300px; height: 6px; border-radius: 3px; background: #232a35; overflow: hidden; }
    .bar { height: 100%; width: 0%; border-radius: 3px; background: #4d7cfe; transition: width 0.3s ease; transform: none; }
    .bar.indeterminate { width: 30%; animation: dsh-slide 1.2s ease-in-out infinite; }
    @keyframes dsh-slide { 0% { transform: translateX(-120%); } 100% { transform: translateX(420%); } }
    .pct { font-size: 12px; color: #9aa4b2; }
    .err { color: #e07c7c; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 id="title">DSH · DeepSeek Harness Desktop</h1>
    <div class="sub" id="status">正在启动…</div>
    <div class="track"><div class="bar" id="bar"></div></div>
    <div class="pct" id="pct">0%</div>
  </div>
  <script>
    const status = document.getElementById('status')
    const bar = document.getElementById('bar')
    const pct = document.getElementById('pct')
    const title = document.getElementById('title')
    if (window.desktop && window.desktop.onSplashStatus) {
      window.desktop.onSplashStatus((payload) => {
        if (payload.message) status.textContent = payload.message
        if (typeof payload.progress === 'number') {
          bar.style.width = payload.progress + '%'
          bar.classList.remove('indeterminate')
          pct.textContent = Math.round(payload.progress) + '%'
        } else if (payload.message) {
          // No numeric progress available: show an animated indeterminate bar
          // instead of a stuck 0%.
          bar.classList.add('indeterminate')
          pct.textContent = '…'
        }
        if (payload.error) {
          status.classList.add('err')
          title.textContent = 'DSH · 启动出错'
        }
      })
    }
  </script>
</body>
</html>`

function setState(patch) {
  Object.assign(state, patch)
  pushState()
}

// ── windows ─────────────────────────────────────────────────────────────────

/**
 * Show a small dark window immediately on boot with a status line. The window
 * stays visible while the engine installs (pnpm pull + tree build on first
 * run) and the harness subprocess comes up; once `serviceUrl` is known we
 * close it and open the real harness window. Without this, double-clicking
 * the app appears to do nothing for tens of seconds.
 */
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#12161c',
    autoHideMenuBar: true,
    title: 'DSH · DeepSeek Harness Desktop',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  splashWindow.removeMenu()
  splashWindow.on('closed', () => { splashWindow = undefined })
  splashWindow.once('ready-to-show', () => {
    splashWindow.show()
    splashWindow.focus()
  })
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML))
  // Replay the latest buffered status once the page (and its listener) is up.
  splashWindow.webContents.on('did-finish-load', () => {
    if (pendingSplashStatus !== undefined) {
      splashWindow.webContents.send('dsh:splash:status', pendingSplashStatus)
    }
  })
  return splashWindow
}

function destroySplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.removeAllListeners('close')
    splashWindow.close()
  }
  splashWindow = undefined
}

/**
 * Create the splash window on demand. Normal launches skip it entirely —
 * the harness window opens directly (see boot). It only appears when the
 * engine needs installing/updating or the harness takes longer than the
 * splash threshold to come up, so a quick launch never flashes it.
 */
function ensureSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return
  createSplashWindow()
}

function createUiWindow(url) {
  uiWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'DeepSeek Harness',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  uiWindow.on('close', (event) => {
    // Closing the UI window parks the app in the tray; only the quit path
    // (which flips `quitting` in `before-quit`) actually closes the window.
    if (!quitting) {
      event.preventDefault()
      windowHiddenByUser = true
      uiWindow.hide()
    }
  })
  uiWindow.on('closed', () => { uiWindow = undefined })
  uiWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  uiWindow.on('render-process-gone', (_event, details) => {
    log(`[ui] renderer gone: ${details.reason}`)
  })
  uiWindow.loadURL(url)
  windowHiddenByUser = false
  return uiWindow
}

function openUi(force = false) {
  const target = state.serviceUrl
  if (uiWindow && !uiWindow.isDestroyed()) {
    if (uiWindow.webContents.getURL() !== target && target !== undefined) {
      uiWindow.loadURL(target)
    }
    // `force` only applies to explicit user requests (tray click, shortcut,
    // second instance). Background readiness (waitForService/adoptService)
    // creates the window on first boot but must NOT resurrect a window the
    // user hid by clicking the close button — that would make the harness
    // window "reopen by itself" whenever a restart completes. A window hidden
    // programmatically (version switch / auto-update) SHOULD come back.
    if (force || uiWindow.isVisible() || !windowHiddenByUser) {
      uiWindow.show()
      uiWindow.focus()
    }
    return
  }
  if (target) {
    destroySplash()
    createUiWindow(target)
  }
}

let windowHiddenByUser = false

function openLogLogFolder() {
  const dir = path.dirname(logger.path())
  fs.mkdirSync(dir, { recursive: true })
  shell.openPath(dir)
}

// ── tray & shortcut ─────────────────────────────────────────────────────────

function createTray() {
  try {
    const image = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 })
    tray = new Tray(image)
    tray.setToolTip('DSH · DeepSeek Harness Desktop')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示界面', click: () => openUi(true) },
      { label: '打开日志文件夹', click: openLogLogFolder },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
    tray.on('click', () => openUi(true))
  } catch (error) {
    log(`[tray] failed to create tray: ${String(error)}`)
  }
}

function registerShortcut() {
  globalShortcut.unregisterAll()
  const binding = engine.state.shortcut || 'Ctrl+Shift+D'
  try {
    globalShortcut.register(binding, () => openUi(true))
  } catch (error) {
    log(`[shortcut] register ${binding} failed: ${String(error)}`)
  }
}

// ── engine lifecycle ────────────────────────────────────────────────────────

function restartService() {
  const version = engine.state.current
  if (version === undefined) return
  intentionalStop = true
  restartInProgress = true
  engine.stopWeb().finally(() => {
    intentionalStop = false
    serviceStartedOk = false
    restartInProgress = false
    startService(version)
  })
}

function startService(version) {
  // Guard against double spawns (a ready harness exiting can race with a
  // scheduled restart, spawning two subprocesses that fight over :3080).
  if (startingService) {
    log('[engine] startService: already starting, ignoring duplicate call')
    return
  }
  startingService = true
  const finish = () => { startingService = false }
  // The harness refuses --host 0.0.0.0 (remote code execution exposure);
  // validate LAN config before spawning so a bad value does not trigger an
  // endless crash/restart loop. An empty lanHost is fine — spawnWeb only
  // adds --host when a host is set, so the service stays on loopback.
  if (engine.state.lan && engine.state.lanHost === '0.0.0.0') {
    const error = '局域网监听地址不能是 0.0.0.0（安全限制）。请填写具体的局域网 IP（例如 192.168.1.100）。'
    log(`[engine] ${error}`)
    setState({ serviceRunning: false, error })
    finish()
    return
  }
  log(`[engine] starting harness v${version} (port ${engine.state.port})`)
  engine.spawnWeb(version)
  reloadedForService = false
  // The UI window opens only once the harness prints its authenticated URL
  // (waitForService → openUi): newer engines require the per-process launch
  // token carried by that URL, so loading the bare origin first would flash
  // the 401 auth page. First-run installs still go through the splash.
  waitForService().finally(finish)
}

let reloadedForService = false

function waitForService() {
  return new Promise((resolve) => {
    let settled = false
    let deadlineTimer = undefined
    const finish = () => {
      if (settled) return
      settled = true
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      engine.off('url', onUrl)
      resolve()
    }
    const onUrl = (url) => {
      if (settled) return
      serviceStartedOk = true
      restartAttempts = 0
      setState({ serviceRunning: true, serviceUrl: url, error: undefined })
      log(`[engine] harness ready at ${url}`)
      // Open the harness window (destroys the splash) at the authenticated
      // URL. On a restart the window already exists; openUi won't resurrect
      // one the user hid.
      openUi()
      // Reload once per service start so the window lands on the real page
      // (its previous load may predate the launch-token exchange).
      if (uiWindow && !uiWindow.isDestroyed() && !reloadedForService) {
        reloadedForService = true
        uiWindow.webContents.reload()
      }
      finish()
    }
    const fail = (message) => {
      if (settled) return
      if (quitting) { finish(); return }
      log(`[engine] ${message}`)
      setState({ serviceRunning: false, error: message })
      ensureSplash()
      sendSplashStatus(message, 100)
      finish()
    }
    // The `dsh web:` URL line is the harness's own readiness signal; the
    // token URL can arrive before this listener attaches, so check first.
    if (engine.authenticatedUrl !== undefined) {
      onUrl(engine.authenticatedUrl)
      return
    }
    engine.on('url', onUrl)
    deadlineTimer = setTimeout(async () => {
      const health = await engine.healthCheck()
      if (health.ok && !health.isHarness) {
        fail(`端口 ${engine.state.port} 被其他程序占用（非 DeepSeek Harness 页面）`)
      } else {
        fail('服务启动超时（90 秒），请查看日志')
      }
    }, 90000)
  })
}

function scheduleRestart(version) {
  if (quitting) return
  restartAttempts += 1
  if (restartAttempts > RESTART_MAX_ATTEMPTS) {
    const error = `服务连续退出 ${RESTART_MAX_ATTEMPTS} 次，已停止自动重启；请查看日志或复制诊断信息`
    log(`[engine] ${error}`)
    setState({ serviceRunning: false, error })
    return
  }
  const delay = RESTART_BACKOFF_MS * restartAttempts
  log(`[engine] harness exited unexpectedly; restarting in ${delay / 1000}s (attempt ${restartAttempts})`)
  setState({ serviceRunning: false, error: undefined })
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    // Before respawning, check whether a harness is already serving the
    // port (e.g. an adopted instance); if so adopt instead of double-spawn.
    engine.healthCheck().then((health) => {
      if (health.ok && health.isHarness) {
        adoptService()
      } else {
        startService(version)
      }
    })
  }, delay)
}

function adoptService() {
  serviceStartedOk = true
  setState({
    serviceRunning: true,
    serviceUrl: `http://127.0.0.1:${engine.state.port}`,
    error: undefined,
  })
  log(`[engine] adopting existing harness on port ${engine.state.port}`)
  openUi()
}

// ── version management ──────────────────────────────────────────────────────

async function checkRegistry() {
  try {
    const info = await engine.registry()
    registryCache = info
    const latest = info[engine.state.channel] ?? info.latest
    const current = state.engineVersion
    const updateAvailable = current !== undefined && latest !== undefined && latest !== current
    setState({
      latestVersion: latest,
      updateAvailable,
      availableVersions: [...new Set([...engine.installedVersions(), ...info.versions])],
    })
    // Background-download a newer engine whenever one exists and isn't
    // installed yet — this covers the first launch seeded from the bundled
    // version. Downloading never restarts or blocks; the settings UI shows a
    // "重启生效" prompt when done, and the next launch applies it (see boot).
    if (updateAvailable && !state.installing && latest !== undefined
      && !engine.isInstalled(latest)) {
      void autoUpdateEngine(latest)
    }
  } catch (error) {
    log(`[registry] check failed: ${String(error)}`)
    setState({
      latestVersion: state.latestVersion,
      updateAvailable: false,
      availableVersions: [...new Set(engine.installedVersions())],
    })
  }
}

/**
 * Auto-update: download a newer engine version WITHOUT restarting (so a
 * launch or a running session is never blocked by the download). When the
 * download finishes, `pendingUpdate` is set and the settings UI shows a
 * "重启生效" prompt; the harness keeps running on the current version until
 * then, and the next launch picks the new version automatically.
 * Startup auto-checks call this without progress UI; the settings "立即安装"
 * button opts into a progress splash.
 * @param {string} version - target engine version.
 * @param {{ showProgress?: boolean }} [options] - show the download splash.
 */
async function autoUpdateEngine(version, options = {}) {
  if (state.installing !== undefined) return
  const showProgress = options.showProgress === true
  log(`[engine] ${showProgress ? '' : 'background '}auto-update to v${version}…`)
  if (showProgress) {
    ensureSplash()
    sendSplashStatus(`正在下载引擎 v${version}…`, 0)
  }
  try {
    await installEngine(version)
    setState({ pendingUpdate: version })
    log(`[engine] v${version} downloaded; restart to apply`)
  } catch (error) {
    log(`[engine] auto-update failed: ${String(error)}`)
  } finally {
    if (showProgress) destroySplash()
  }
}

/**
 * Apply a downloaded engine update: switch the current version and restart
 * the harness. Called from the settings "重启生效" button.
 */
async function applyPendingUpdate() {
  const version = state.pendingUpdate
  if (version === undefined) return
  try {
    setState({ pendingUpdate: undefined })
    await switchVersion(version)
  } catch (error) {
    setState({ error: String(error) })
  }
}

async function installEngine(version) {
  setState({ installing: version })
  log(`[engine] installing v${version} …`)
  // Refresh the splash (indeterminate progress) while the install runs. The
  // status call no-ops when no splash is visible, so a background auto-download
  // stays quiet and only foreground installs (boot / version switch) animate.
  let lastProgressAt = 0
  try {
    await engine.install(version, (line) => {
      log(`[pnpm] ${line.trimEnd()}`)
      const now = Date.now()
      if (now - lastProgressAt >= 500) {
        lastProgressAt = now
        sendSplashStatus(`正在下载并安装引擎 v${version}…`)
      }
    })
    sendSplashStatus(`引擎 v${version} 安装完成`, 100)
    log(`[engine] v${version} installed`)
  } catch (error) {
    const message = `引擎安装失败: ${String(error)}`
    log(`[engine] ${message}`)
    setState({ installing: undefined, error: message })
    sendSplashStatus(message, 100)
    throw error
  } finally {
    if (state.installing === version) setState({ installing: undefined })
  }
}

async function switchVersion(version) {
  if (version === state.engineVersion && serviceStartedOk) return
  if (!engine.isCredentialCompatible(version)) {
    const error = `引擎 v${version} 与当前凭据文件格式不兼容（需 ${engine.credentialFormat(version) === 'flat' ? '扁平' : 'version/refs'} 格式）。建议保持当前版本。`
    log(`[engine] ${error}`)
    setState({ error })
    return
  }
  try {
    if (!engine.verifyInstalled(version)) {
      ensureSplash()
      sendSplashStatus(`正在安装引擎 v${version}…`)
      await installEngine(version)
    } else {
      // Already installed: hide the live harness window while we restart so
      // the user sees a progress splash instead of the page reloading over
      // and over during the switch.
      ensureSplash()
      sendSplashStatus(`正在切换到引擎 v${version}…`)
      if (uiWindow && !uiWindow.isDestroyed()) uiWindow.hide()
    }
    engine.updateState({ current: version })
    setState({ engineVersion: version })
    intentionalStop = true
    await engine.stopWeb()
    intentionalStop = false
    serviceStartedOk = false
    startService(version)
    void checkRegistry()
  } catch (error) {
    setState({ error: String(error) })
  } finally {
    destroySplash()
  }
}

// ── shell auto-update ───────────────────────────────────────────────────────

function setupShellUpdater() {
  if (!app.isPackaged) return
  try {
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('update-available', () => {
      log('[shell] update available')
      setState({ shellUpdateAvailable: true })
      dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: 'DeepSeek Harness Desktop 有新版本可用',
        buttons: ['下载并安装', '以后再说'],
      }).then(({ response }) => {
        if (response === 0) void downloadShellUpdate()
      })
    })
    autoUpdater.on('update-not-available', () => log('[shell] no update available'))
    autoUpdater.on('error', (error) => {
      log(`[shell] updater error: ${String(error)}`)
      destroySplash()
    })
    autoUpdater.on('download-progress', (progress) => {
      const percent = typeof progress.percent === 'number' ? Math.round(progress.percent) : 0
      log(`[shell] download ${percent}%`)
      sendSplashStatus(`正在下载新版本… ${percent}%`, percent)
    })
    autoUpdater.on('update-downloaded', () => {
      log('[shell] update downloaded')
      sendSplashStatus('下载完成，准备安装…', 100)
      dialog.showMessageBox({
        type: 'info',
        title: '更新已就绪',
        message: '新版本已下载，重启应用以完成安装',
        buttons: ['立即重启', '稍后'],
      }).then(({ response }) => {
        if (response === 0) {
          quitting = true
          autoUpdater.quitAndInstall()
        } else {
          destroySplash()
        }
      })
    })
    autoUpdater.checkForUpdates().catch((error) => log(`[shell] check failed: ${String(error)}`))
  } catch (error) {
    log(`[shell] updater unavailable: ${String(error)}`)
  }
}

async function downloadShellUpdate() {
  if (!autoUpdater) return
  ensureSplash()
  sendSplashStatus('正在下载新版本…', 0)
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    log(`[shell] download failed: ${String(error)}`)
    destroySplash()
  }
}

// ── diagnostics ─────────────────────────────────────────────────────────────

function diagnosticsText() {
  let tail = ''
  try {
    const file = logger.path()
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    tail = lines.slice(-120).join('\n')
  } catch { /* no log yet */ }
  return [
    'DeepSeek Harness Desktop 诊断信息',
    `时间: ${new Date().toISOString()}`,
    `平台: ${process.platform} ${process.arch}`,
    `应用版本: ${app.getVersion()}`,
    `引擎版本: ${state.engineVersion ?? '未安装'}`,
    `最新版本: ${state.latestVersion ?? '未知'}`,
    `端口: ${state.port}`,
    `Node: ${engine.nodeBinary()}`,
    `数据目录: ${app.getPath('userData')}`,
    `状态: ${state.error ?? (state.serviceRunning ? '服务运行中' : '未知')}`,
    '---- 最近日志 ----',
    tail,
  ].join('\n')
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle('dsh:getState', () => state)
  ipcMain.handle('dsh:getAvailableVersions', () => state.availableVersions)
  ipcMain.handle('dsh:updateEngine', async () => {
    if (state.installing || state.latestVersion === undefined) return
    // User-initiated install from the settings page: show the download splash.
    await autoUpdateEngine(state.latestVersion, { showProgress: true })
  })
  ipcMain.handle('dsh:applyPendingUpdate', () => applyPendingUpdate())
  ipcMain.handle('dsh:switchVersion', (_event, version) => switchVersion(String(version)))
  ipcMain.handle('dsh:updateShell', () => downloadShellUpdate())
  ipcMain.handle('dsh:setSettings', (_event, patch) => {
    const previous = { port: engine.state.port, lan: engine.state.lan, lanHost: engine.state.lanHost }
    engine.updateState(patch)
    setState({
      port: engine.state.port,
      channel: engine.state.channel,
      autoUpdate: engine.state.autoUpdate,
      shortcut: engine.state.shortcut,
      lan: engine.state.lan,
      lanHost: engine.state.lanHost,
      trustedHosts: engine.state.trustedHosts,
    })
    registerShortcut()
    const needsRestart = patch.port !== undefined && patch.port !== previous.port
      || patch.lan !== undefined && patch.lan !== previous.lan
      || patch.lanHost !== undefined && patch.lanHost !== previous.lanHost
    if (needsRestart && serviceStartedOk) restartService()
    void checkRegistry()
  })
  ipcMain.handle('dsh:openLogFolder', openLogLogFolder)
  ipcMain.handle('dsh:copyDiagnostics', () => {
    clipboard.writeText(diagnosticsText())
    return true
  })
  ipcMain.handle('dsh:quit', () => app.quit())
}

// ── shell settings sync ────────────────────────────────────────────────────

let shellSettingsMtimeMs = 0
let shellApplyMtimeMs = 0
let shellPollTimer = undefined

/** @param {string} file @returns {number | undefined} */
function safeMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Mirror shell settings + apply requests written by the in-page UI (which can
 * only reach the desktop-shell plugin's HTTP endpoints) back into the engine
 * state. The plugin writes `<userData>/engine/desktop-shell.json` and
 * `<userData>/engine/apply-request.json`; we poll their mtime every two seconds.
 */
function startShellSync() {
  if (shellPollTimer !== undefined) return
  const dir = path.join(app.getPath('userData'), 'engine')
  const settingsFile = path.join(dir, SHELL_SETTINGS_FILE)
  const applyFile = path.join(dir, SHELL_APPLY_FILE)
  fs.mkdirSync(dir, { recursive: true })

  // Seed the file from `engine.state` defaults on first boot so the in-page
  // settings panel always has current values (port, channel, shortcut, ...) and
  // the user's first interaction isn't a wall of empty fields.
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        channel: engine.state.channel,
        port: engine.state.port,
        autoUpdate: engine.state.autoUpdate,
        shortcut: engine.state.shortcut,
        lan: engine.state.lan,
        lanHost: engine.state.lanHost,
        trustedHosts: engine.state.trustedHosts,
      }, null, 2),
    )
  }

  shellSettingsMtimeMs = safeMtimeMs(settingsFile) ?? 0
  shellApplyMtimeMs = safeMtimeMs(applyFile) ?? 0

  const tick = () => {
    try {
      const settingsMtime = safeMtimeMs(settingsFile)
      if (settingsMtime !== undefined && settingsMtime > shellSettingsMtimeMs) {
        shellSettingsMtimeMs = settingsMtime
        const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
        const patch = {}
        for (const key of ['channel', 'port', 'autoUpdate', 'shortcut', 'lan', 'lanHost', 'trustedHosts']) {
          if (Object.hasOwn(stored, key)) patch[key] = stored[key]
        }
        if (Object.keys(patch).length > 0) {
          engine.updateState(patch)
          setState({
            port: engine.state.port,
            channel: engine.state.channel,
            autoUpdate: engine.state.autoUpdate,
            shortcut: engine.state.shortcut,
            lan: engine.state.lan,
            lanHost: engine.state.lanHost,
            trustedHosts: engine.state.trustedHosts,
          })
          registerShortcut()
          // Do NOT auto-restart here: the settings page writes changes via
          // POST /settings (mirrored here), and restarting on every field
          // change would bounce the user back to the conversation for each
          // checkbox/keystroke. Only the explicit apply (apply-request.json)
          // below triggers a service restart.
        }
        log('[shell] settings mirrored from plugin')
      }

      const applyMtime = safeMtimeMs(applyFile)
      if (applyMtime !== undefined && applyMtime > shellApplyMtimeMs) {
        shellApplyMtimeMs = applyMtime
        const request = JSON.parse(fs.readFileSync(applyFile, 'utf8'))
        log(`[shell] apply requested (${request.reason ?? 'unspecified'})`)
        // The settings page's "立即重启服务" button writes this sentinel;
        // apply the mirrored settings by restarting the harness so lan/port
        // take effect.
        if (serviceStartedOk) restartService()
      }
    } catch (error) {
      log(`[shell] sync error: ${String(error)}`)
    }
  }
  tick()
  shellPollTimer = setInterval(tick, SHELL_POLL_MS)
}

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  logger = createLogger(path.join(app.getPath('userData'), 'logs'))
  log(`[start] DeepSeek Harness Desktop v${app.getVersion()} 启动 (userData: ${app.getPath('userData')})`)
  engine = new EngineManager({
    userData: app.getPath('userData'),
    projectRoot: PROJECT_ROOT,
    resources: RESOURCES,
    log: { log: (line) => log(line) },
  })

  engine.on('exit', ({ code, signal, version }) => {
    log(`[engine] harness exited (code ${code}, signal ${signal ?? 'none'})`)
    if (quitting || intentionalStop || restartInProgress) return
    if (!serviceStartedOk) {
      // Startup-phase exit: likely a port bind failure or bad install.
      engine.healthCheck().then((health) => {
        if (health.ok && !health.isHarness) {
          setState({ serviceRunning: false, error: `端口 ${engine.state.port} 被其他程序占用` })
        } else {
          scheduleRestart(version)
        }
      })
      return
    }
    scheduleRestart(version)
  })

  registerIpc()
  startShellSync()
  setState({
    engineVersion: engine.state.current,
    channel: engine.state.channel,
    port: engine.state.port,
    autoUpdate: engine.state.autoUpdate,
    shortcut: engine.state.shortcut,
    lan: engine.state.lan,
    lanHost: engine.state.lanHost,
    trustedHosts: engine.state.trustedHosts,
    runtimeLine: `运行时: ${engine.nodeBinary()}`,
  })
  createTray()
  registerShortcut()
  setupShellUpdater()

  // Installed-engine launches open the harness window directly (startService
  // calls openUi), so no splash flashes on the fast path. The splash with a
  // progress bar only appears for slow work: first-run engine install,
  // an update, or when the port needs adopting.
  const installed = engine.state.current !== undefined && engine.isInstalled(engine.state.current)
  if (!installed) {
    ensureSplash()
    sendSplashStatus('正在检查引擎…', 10)
  }

  // Remove broken installed trees first: copies from the old bundled-engine
  // seed lost pnpm's per-package dependency links and crash on boot, and they
  // must never be picked as the target.
  const purged = engine.purgeBrokenVersions()
  if (purged.length > 0) log(`[engine] removed broken engine versions: ${purged.join(', ')}`)

  // Target = current persisted version. If a newer version was downloaded in
  // a previous session (background auto-update), the next launch uses it —
  // background downloads always happen, so the newest installed version is
  // always the best to boot.
  let target = engine.state.current
  const newestInstalled = engine.installedVersions().filter((v) => engine.verifyInstalled(v))[0]
  if (newestInstalled !== undefined && newestInstalled !== target) {
    target = newestInstalled
    log(`[engine] using newest installed engine: v${target}`)
  }
  target = target ?? await engine.resolveTarget()
  if (target === undefined) {
    const error = '未找到可用引擎：无法连接 npm registry 且本机没有已安装版本，请联网后重启'
    log(`[engine] ${error}`)
    setState({ error })
    ensureSplash()
    sendSplashStatus(error, 100)
    return
  }

  // Engine missing → this is a first-run / fresh install: show the splash so
  // the user gets progress instead of a silent wait.
  if (!engine.verifyInstalled(target)) {
    ensureSplash()
    sendSplashStatus(`正在安装引擎 v${target}…`, 40)
    try {
      await installEngine(target)
    } catch {
      return
    }
  }
  setState({ engineVersion: target })
  engine.updateState({ current: target })

  const health = await engine.healthCheck()
  if (health.ok && health.isHarness) {
    sendSplashStatus('引擎已就绪…', 90)
    adoptService()
  } else {
    sendSplashStatus('正在启动引擎…', 60)
    startService(target)
  }
  void checkRegistry()
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // Another instance is already running (it will route to openUi via
  // second-instance); exit this one instead of fighting for the harness port.
  app.quit()
} else {
  app.on('second-instance', () => {
    openUi(true)
  })

  app.whenReady().then(() => {
    void boot()
  })
}

app.on('before-quit', () => {
  // Flip the residency guard BEFORE windows receive `close` so the UI
  // window's close handler lets the window actually close.
  quitting = true
})

app.on('will-quit', () => {
  log('[stop] DeepSeek Harness Desktop 退出')
  globalShortcut.unregisterAll()
  clearTimeout(restartTimer)
  if (shellPollTimer !== undefined) clearInterval(shellPollTimer)
  if (engine) void engine.stopWeb()
})

app.on('window-all-closed', (event) => {
  // Tray residency: never quit on a user-initiated window close. The quit
  // path goes before-quit → close → window-all-closed; `quitting` is already
  // true there, so we let Electron exit normally.
  if (!quitting) event.preventDefault()
})