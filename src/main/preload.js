'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();
ipcRenderer.on('event', (_e, { channel, payload }) => {
  for (const cb of listeners.get(channel) || []) {
    try { cb(payload); } catch (err) { console.error(err); }
  }
});

contextBridge.exposeInMainWorld('termclaw', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, ...args),
  // Local path of a file dropped from the Explorer / Finder.
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel).delete(cb);
  },
});
