// main.js — Electron main process
// Handles: app lifecycle, windows, system tray, notifications, IPC routing

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, session, systemPreferences } = require('electron')
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

function createWindow(htmlFile, width, height, extraPrefs = {}) {
  const win = new BrowserWindow({
    width,
    height,
    resizable: false,
    backgroundColor: '#0e0e16',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,      // needed so the renderer can dynamic-import MediaPipe from CDN
      webSecurity: false,  // allows cross-origin WASM/model fetches from CDN (tighten before prod)
      ...extraPrefs,
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

function openHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show()
    historyWin.focus()
    return
  }
  historyWin = createWindow('history.html', 420, 520)
}

function openDashboard() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = createWindow('dashboard.html', 420, 600)

  // Hide to tray on close rather than quitting
  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow.hide()
  })
}

function openOnboarding() {
  onboardingWin = createWindow('onboarding.html', 500, 640)
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

let tray = null

function setupTray() {
  // Start with an empty icon — the dashboard will push a live score image once tracking starts
  tray = new Tray(nativeImage.createEmpty())

  // macOS: brain emoji anchors the tray item while the score icon loads
  if (process.platform === 'darwin') tray.setTitle(' 🧠')

  setTrayStatus('Starting up...')
  tray.on('click', openDashboard)
}

function setTrayStatus(statusText) {
  const menu = Menu.buildFromTemplate([
    { label: `Lobi  ·  ${statusText}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: openDashboard },
    { type: 'separator' },
    { label: 'Quit Lobi', click: () => app.exit(0) },
  ])
  tray.setContextMenu(menu)
  tray.setToolTip(`Lobi — ${statusText}`)
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
})

// Keep the app alive in the tray even when all windows are closed
app.on('window-all-closed', () => { /* intentionally empty */ })

// macOS dock click — re-open the dashboard
app.on('activate', openDashboard)
