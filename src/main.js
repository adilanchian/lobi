// main.js — Electron main process
// Handles: app lifecycle, windows, system tray, notifications, IPC routing

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, session, systemPreferences, screen } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs   = require('fs')

// ─── Settings ─────────────────────────────────────────────────────────────────
// Tiny JSON file in the OS userData folder so settings persist across restarts

const SETTINGS_FILE  = path.join(app.getPath('userData'), 'settings.json')
const SESSIONS_FILE  = path.join(app.getPath('userData'), 'sessions.json')

function readSettings() {
  try   { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
  catch { return { onboardingDone: false } }
}

function writeSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2))
}

function readSessions() {
  try   { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) }
  catch { return [] }
}

function writeSessions(data) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true })
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
}

// ─── Window Factory ───────────────────────────────────────────────────────────

/** `opts` are BrowserWindow options (e.g. resizable, minWidth). Use `webPreferences` inside opts only for renderer overrides. */
function createWindow(htmlFile, width, height, opts = {}) {
  const { webPreferences: wpOverrides = {}, ...bwOpts } = opts
  const win = new BrowserWindow({
    width,
    height,
    backgroundColor: '#0e0e16',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...bwOpts,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,      // needed so the renderer can dynamic-import MediaPipe from CDN
      webSecurity: false,  // allows cross-origin WASM/model fetches from CDN (tighten before prod)
      ...wpOverrides,
    },
  })

  // Prevents Chromium from throttling JS timers when the window is hidden/backgrounded
  win.webContents.on('did-finish-load', () => {
    win.webContents.setBackgroundThrottling(false)
  })

  win.loadFile(path.join(__dirname, htmlFile))
  return win
}

// ─── Windows ──────────────────────────────────────────────────────────────────

let mainWindow     = null
let onboardingWin  = null
let historyWin     = null
let isQuitting     = false  // flips true once we actually want to shut down

function openHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show()
    historyWin.focus()
    return
  }
  historyWin = createWindow('history.html', 540, 660, { resizable: true, minWidth: 360, minHeight: 400 })
}

function openDashboard() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = createWindow('dashboard.html', 680, 940, {
    resizable: true,
    minWidth: 440,
    minHeight: 600,
  })

  // macOS: red-X hides to tray unless we're truly quitting.
  // Windows/Linux: red-X should fully quit the app.
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin') {
      if (isQuitting) return
      e.preventDefault()
      mainWindow.hide()
      return
    }

    if (!isQuitting) {
      isQuitting = true
      app.quit()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function openOnboarding() {
  onboardingWin = createWindow('onboarding.html', 640, 820, {
    resizable: true,
    minWidth: 440,
    minHeight: 560,
  })
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

let tray = null

// Update state drives the "Check for Updates" menu item label + behaviour
const UpdateState = {
  IDLE:        'idle',
  CHECKING:    'checking',
  DOWNLOADING: 'downloading',
  READY:       'ready',
  UP_TO_DATE:  'up-to-date',
  ERROR:       'error',
}
let updateState   = UpdateState.IDLE
let updateVersion = null   // set once we know what version is available
let focusStatus   = 'Starting up...'

function buildUpdateMenuItem() {
  switch (updateState) {
    case UpdateState.CHECKING:
      return { label: 'Checking for Updates…', enabled: false }
    case UpdateState.DOWNLOADING:
      return { label: `Downloading v${updateVersion}…`, enabled: false }
    case UpdateState.READY:
      return {
        label: `Restart to Install v${updateVersion}`,
        click: () => { isQuitting = true; autoUpdater.quitAndInstall() },
      }
    case UpdateState.UP_TO_DATE:
      return { label: 'Up to Date ✓', enabled: false }
    case UpdateState.ERROR:
      return {
        label: 'Update Check Failed — Retry',
        click: () => { if (app.isPackaged) autoUpdater.checkForUpdates() },
      }
    default: // IDLE
      return {
        label: 'Check for Updates',
        click: () => { if (app.isPackaged) autoUpdater.checkForUpdates() },
      }
  }
}

function buildTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: `Lobi  ·  ${focusStatus}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: openDashboard },
    { type: 'separator' },
    buildUpdateMenuItem(),
    { type: 'separator' },
    { label: 'Quit Lobi', click: () => { isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(`Lobi — ${focusStatus}`)
}

function rebuildTrayMenu() {
  if (tray) buildTrayMenu()
}

function setupTray() {
  // Start with an empty icon — the dashboard will push a live score image once tracking starts
  tray = new Tray(nativeImage.createEmpty())

  // macOS: brain emoji anchors the tray item while the score icon loads
  if (process.platform === 'darwin') tray.setTitle(' 🧠')

  buildTrayMenu()
  tray.on('click', openDashboard)
}

function setTrayStatus(statusText) {
  focusStatus = statusText
  rebuildTrayMenu()
}

// ─── Notifications ────────────────────────────────────────────────────────────

let notificationsEnabled = true  // default true for users who skipped onboarding

function sendNotification(title, body) {
  if (!notificationsEnabled) return
  if (!Notification.isSupported()) return
  new Notification({ title, body }).show()
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
// The renderer communicates up to main via window.lobi.* (see preload.js)

// Triggers the native macOS camera permission dialog (must come from main process)
ipcMain.handle('request-camera-permission', async () => {
  if (process.platform === 'darwin') {
    return await systemPreferences.askForMediaAccess('camera')
  }
  return true  // Windows/Linux handle permissions at the getUserMedia level
})

// Triggers the OS notification permission prompt by sending a welcome notification.
// On macOS, the system asks for permission the first time any notification is shown.
ipcMain.handle('request-notification-permission', () => {
  if (!Notification.isSupported()) return false
  new Notification({
    title: 'Lobi is ready 🧠',
    body: "You'll get a nudge when your brain needs a reset.",
  }).show()
  return true
})

ipcMain.on('tray-icon', (_e, dataURL) => {
  const buf   = Buffer.from(dataURL.replace(/^data:image\/png;base64,/, ''), 'base64')
  const image = nativeImage.createFromBuffer(buf, { scaleFactor: 2 })
  tray.setImage(image)
})

ipcMain.on('notify', (_e, { title, body }) => sendNotification(title, body))

ipcMain.on('tray-status', (_e, status) => setTrayStatus(status))

ipcMain.on('hide-window', (e) => BrowserWindow.fromWebContents(e.sender)?.hide())

ipcMain.on('open-history', openHistory)

ipcMain.handle('save-session', (_e, data) => {
  const sessions = readSessions()
  sessions.unshift(data)          // newest first
  if (sessions.length > 50) sessions.pop()
  writeSessions(sessions)
})

ipcMain.handle('get-sessions', () => readSessions())

ipcMain.handle('update-session', (_e, startTime, title) => {
  const sessions = readSessions()
  const s = sessions.find(s => s.startTime === startTime)
  if (s) s.title = title || null
  writeSessions(sessions)
})

ipcMain.handle('get-version', () => app.getVersion())

ipcMain.handle('get-update-state', () => ({ state: updateState, version: updateVersion }))

ipcMain.handle('check-for-update', () => {
  if (app.isPackaged) autoUpdater.checkForUpdates()
  else {
    // In dev, simulate the flow so you can see it work
    mainWindow?.webContents.send('update-state', { state: 'up-to-date' })
  }
})

ipcMain.on('install-update', () => {
  isQuitting = true
  autoUpdater.quitAndInstall()
})

ipcMain.handle('get-display-count', () => screen.getAllDisplays().length)

// Push an updated count whenever monitors are plugged/unplugged.
app.whenReady().then(() => {
  const push = () => mainWindow?.webContents.send('display-count', screen.getAllDisplays().length)
  screen.on('display-added',   push)
  screen.on('display-removed', push)
})

ipcMain.on('reset-onboarding', () => {
  writeSettings({ onboardingDone: false })
  mainWindow?.destroy()
  mainWindow = null
  openOnboarding()
})

ipcMain.on('onboarding-done', (_e, { notificationsEnabled: notifEnabled = true } = {}) => {
  notificationsEnabled = notifEnabled
  writeSettings({ onboardingDone: true, notificationsEnabled: notifEnabled })
  onboardingWin?.destroy()
  openDashboard()
})

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Electron blocks camera access by default — explicitly allow it for our windows
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media'
  })

  const settings = readSettings()
  // Default true so existing users (who never saw the notifications step) keep getting them
  notificationsEnabled = settings.notificationsEnabled !== false

  setupTray()
  settings.onboardingDone ? openDashboard() : openOnboarding()

  // ── Auto-update ─────────────────────────────────────────────────────────────
  // Silently checks on startup; user can also trigger manually from the tray menu.
  // When an update is downloaded, electron-updater installs it on the next app
  // quit (the `before-quit` event path). That only runs via app.quit() — never
  // via app.exit(), which is why the tray menu uses app.quit().
  autoUpdater.autoInstallOnAppQuit = true

  function pushUpdateState(payload) {
    mainWindow?.webContents.send('update-state', payload)
  }

  autoUpdater.on('checking-for-update', () => {
    updateState = UpdateState.CHECKING
    rebuildTrayMenu()
    pushUpdateState({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    updateVersion = info.version
    updateState   = UpdateState.DOWNLOADING
    rebuildTrayMenu()
    pushUpdateState({ state: 'downloading', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    updateState = UpdateState.UP_TO_DATE
    rebuildTrayMenu()
    pushUpdateState({ state: 'up-to-date' })
    setTimeout(() => { updateState = UpdateState.IDLE; rebuildTrayMenu() }, 10_000)
  })

  autoUpdater.on('update-downloaded', (info) => {
    updateVersion = info.version
    updateState   = UpdateState.READY
    rebuildTrayMenu()
    pushUpdateState({ state: 'ready', version: info.version })
    sendNotification(
      'Lobi update ready 🎉',
      `v${info.version} is downloaded. Open Lobi to restart and install.`
    )
  })

  autoUpdater.on('error', () => {
    updateState = UpdateState.ERROR
    rebuildTrayMenu()
    pushUpdateState({ state: 'error' })
    setTimeout(() => { updateState = UpdateState.IDLE; rebuildTrayMenu() }, 10_000)
  })

  // Only check in packaged builds — autoUpdater hangs in dev mode (electron .)
  // Also poll every 6 hours since this app lives in the tray indefinitely.
  if (app.isPackaged) {
    autoUpdater.checkForUpdates()
    setInterval(() => autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000)
  }
})

// macOS: tray keeps the app alive when the dashboard is hidden (window still exists). Windows/Linux: last window closed → quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// macOS dock click — re-open the dashboard
app.on('activate', openDashboard)

// Any quit path (menu-bar Quit, Cmd-Q, taskbar close, auto-update install)
// should flip the flag so `mainWindow.on('close')` stops intercepting.
app.on('before-quit', () => { isQuitting = true })

// Destroy the tray and any remaining windows so Windows releases every
// renderer/helper process cleanly. Without this, hidden windows + the tray
// can keep a zombie menu-bar process alive after the main process exits.
app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.destroy()
  }
})
