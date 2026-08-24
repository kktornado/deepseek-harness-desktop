/**
 * contextBridge surface shared by the harness webview. The Electron main
 * process keeps the only UI: the harness window itself, with the desktop-shell
 * plugin rendering the settings panel + live stats in-page. The bridge is
 * kept narrow — just the diagnostics + lifecycle calls a renderer might
 * still need — and the `onState` push channel for any future in-harness UI
 * that wants to mirror app state.
 * @module preload
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  getState: () => ipcRenderer.invoke('dsh:getState'),
  getAvailableVersions: () => ipcRenderer.invoke('dsh:getAvailableVersions'),
  switchVersion: (version) => ipcRenderer.invoke('dsh:switchVersion', version),
  updateEngine: () => ipcRenderer.invoke('dsh:updateEngine'),
  applyPendingUpdate: () => ipcRenderer.invoke('dsh:applyPendingUpdate'),
  updateShell: () => ipcRenderer.invoke('dsh:updateShell'),
  setSettings: (settings) => ipcRenderer.invoke('dsh:setSettings', settings),
  copyDiagnostics: () => ipcRenderer.invoke('dsh:copyDiagnostics'),
  openLogFolder: () => ipcRenderer.invoke('dsh:openLogFolder'),
  quit: () => ipcRenderer.invoke('dsh:quit'),
  onSplashStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('dsh:splash:status', listener)
    return () => ipcRenderer.removeListener('dsh:splash:status', listener)
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('dsh:state', listener)
    return () => ipcRenderer.removeListener('dsh:state', listener)
  },
})