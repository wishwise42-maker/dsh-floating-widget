/**
 * Preload bridge shared by the floating trigger strip and the floating
 * panel: exposes a tiny, explicit API to the page. Sandbox-safe.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshFloating', {
  open: () => ipcRenderer.send('dsh-floating:open'),
  toggle: () => ipcRenderer.send('dsh-floating:toggle'),
  collapse: () => ipcRenderer.send('dsh-floating:collapse'),
  checkLeave: () => ipcRenderer.send('dsh-floating:check-leave'),
  hover: () => ipcRenderer.send('dsh-floating:hover'),
})
