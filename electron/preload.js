const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  device: { info: () => ipcRenderer.invoke('device:info') },
  discovery: { list: () => ipcRenderer.invoke('discovery:list') },
  pairing: {
    request: (remote) => ipcRenderer.invoke('pairing:request', remote),
    status: (session) => ipcRenderer.invoke('pairing:status', session),
    pending: () => ipcRenderer.invoke('pairing:pending'),
    confirmIncoming: (data) => ipcRenderer.invoke('pairing:confirmIncoming', data),
    rejectIncoming: (data) => ipcRenderer.invoke('pairing:rejectIncoming', data),
    unpair: (data) => ipcRenderer.invoke('pairing:unpair', data),
    onIncoming: (callback) => { const listener = (_event, request) => callback(request); ipcRenderer.on('pairing:incoming', listener); return () => ipcRenderer.removeListener('pairing:incoming', listener); },
  },
  transfer: { info: () => ipcRenderer.invoke('transfer:info'), selectFile: () => ipcRenderer.invoke('transfer:selectFile'), requestChallenge: (input) => ipcRenderer.invoke('transfer:requestChallenge', input) },
  services: { health: () => ipcRenderer.invoke('services:health'), ports: () => ipcRenderer.invoke('services:ports'), setPorts: (ports) => ipcRenderer.invoke('services:setPorts', ports) },
  platform: process.platform,

  getSysInfo: () => ipcRenderer.invoke('sys:info'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  shares: {
    list: () => ipcRenderer.invoke('share:list'),
    add: (p) => ipcRenderer.invoke('share:add', p),
    remove: (id) => ipcRenderer.invoke('share:remove', id),
    resetPassword: (p) => ipcRenderer.invoke('share:resetPassword', p),
    gen: () => ipcRenderer.invoke('share:gen'),
    getSettings: () => ipcRenderer.invoke('share:getSettings'),
    setSettings: (s) => ipcRenderer.invoke('share:setSettings', s),
    syncUnifiedPassword: (p) => ipcRenderer.invoke('share:syncUnifiedPassword', p),
    apiPull: (p) => ipcRenderer.invoke('share:apiPull', p),
    migrateToUnified: (p) => ipcRenderer.invoke('share:migrateToUnified', p),
  },

  mounts: {
    list: () => ipcRenderer.invoke('mount:list'),
    save: (m) => ipcRenderer.invoke('mount:save', m),
    applyAutofs: (m) => ipcRenderer.invoke('mount:applyAutofs', m),
    mountOne: (m) => ipcRenderer.invoke('mount:mountOne', m),
    unmount: (mp) => ipcRenderer.invoke('mount:unmount', mp),
  },

  chat: {
    info: () => ipcRenderer.invoke('chat:info'),
    storageStats: () => ipcRenderer.invoke('chat:storageStats'),
    clearStorage: (scope) => ipcRenderer.invoke('chat:clearStorage', scope),
    exportHistory: (options) => ipcRenderer.invoke('chat:export', options),
    deleteMessages: (ids) => ipcRenderer.invoke('chat:deleteMessages', ids),
  },

  logs: {
    history: () => ipcRenderer.invoke('log:history'),
    /** 订阅实时日志，返回取消订阅函数 */
    onLog: (cb) => {
      const handler = (_e, entry) => cb(entry);
      ipcRenderer.on('log:event', handler);
      return () => ipcRenderer.removeListener('log:event', handler);
    },
  },

});
