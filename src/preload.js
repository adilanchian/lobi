// preload.js — Context bridge between Electron main process and renderer pages
// Exposes a safe `window.lobi` object the renderer can call without Node access

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lobi', {
  // Fire a system notification (insight reached the main process for delivery)
  sendInsight: (title, body) => ipcRenderer.send('notify', { title, body }),

  // Update the menu-bar tray label with the current focus status
  updateTrayStatus: (status) => ipcRenderer.send('tray-status', status),

  // Hide the current window back to the tray
  hideWindow: () => ipcRenderer.send('hide-window'),

  // Called at the end of onboarding — saves the flag and opens the dashboard
  completeOnboarding: () => ipcRenderer.send('onboarding-done'),

  // Triggers the native macOS camera permission dialog from the main process
  requestCameraPermission: () => ipcRenderer.invoke('request-camera-permission'),

  // Triggers the OS notification permission prompt (macOS asks on first notification)
  requestNotificationPermission: () => ipcRenderer.invoke('request-notification-permission'),

  // Sends a canvas-rendered score PNG to main to set as the tray icon
  updateTrayIcon: (dataURL) => ipcRenderer.send('tray-icon', dataURL),

  // Session history
  saveSession:  (data) => ipcRenderer.invoke('save-session', data),
  getSessions:  ()     => ipcRenderer.invoke('get-sessions'),
  openHistory:  ()     => ipcRenderer.send('open-history'),

  // Dev helper — resets onboarding state and reopens the setup flow
  resetOnboarding: () => ipcRenderer.send('reset-onboarding'),
})
