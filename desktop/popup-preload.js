'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Confirm the preload loaded — visible in both renderer DevTools console and main log
console.log('popup-preload.js loaded');
ipcRenderer.invoke('preload-loaded').catch(() => {});

contextBridge.exposeInMainWorld('electronAPI', {
  // Called on popup startup — returns whatever usageData the main process has right now
  getUsage: () => ipcRenderer.invoke('get-usage'),

  // Register a callback for real-time pushes from the main process
  onUsagePush: (cb) => {
    ipcRenderer.on('usage-push', (_event, data) => cb(data));
  },

  // Auto-updater
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-downloaded', (_event, info) => cb(info));
  },
  openDownloadPage: () => {
    console.log('preload: invoking open-download-page');
    return ipcRenderer.invoke('open-download-page');
  },
});
