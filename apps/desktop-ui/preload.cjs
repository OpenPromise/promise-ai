const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  onWake: (callback) => {
    ipcRenderer.on('wake', () => callback());
  },
  onSleep: (callback) => {
    ipcRenderer.on('sleep', () => callback());
  },
  onOrbClick: (callback) => {
    ipcRenderer.on('orb-click', () => callback());
  },
  onThemeChange: (callback) => {
    ipcRenderer.on('theme', (_event, name) => callback(name));
  },
  requestSleep: () => ipcRenderer.send('sleep'),
  requestHide: () => ipcRenderer.send('hide'),
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  setOrbIcon: (dataUrl) => ipcRenderer.send('set-orb-icon', dataUrl),
  setWindowMode: (mode) => ipcRenderer.send('set-window-mode', mode),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
});
