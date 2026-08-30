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
    onRevoked: (callback) => { const listener = (_event, info) => callback(info); ipcRenderer.on('pairing:revoked', listener); return () => ipcRenderer.removeListener('pairing:revoked', listener); },
  },
  transfer: {
    info: () => ipcRenderer.invoke('transfer:info'),
    selectFile: (kind) => ipcRenderer.invoke('transfer:selectFile', kind),
    offer: (input) => ipcRenderer.invoke('transfer:offer', input),
    sends: () => ipcRenderer.invoke('transfer:sends'),
    removeSend: (transferId) => ipcRenderer.invoke('transfer:removeSend', transferId),
    getSettings: () => ipcRenderer.invoke('transfer:getSettings'),
    setSettings: (settings) => ipcRenderer.invoke('transfer:setSettings', settings),
    selectCacheDir: () => ipcRenderer.invoke('transfer:selectCacheDir'),
    listOffers: () => ipcRenderer.invoke('transfer:listOffers'),
    decide: (input) => ipcRenderer.invoke('transfer:decide', input),
    status: (transferId) => ipcRenderer.invoke('transfer:status', transferId),
  },
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
  host: {
    list: () => ipcRenderer.invoke('host:list'),
    set: (data) => ipcRenderer.invoke('host:set', data),
    remove: (data) => ipcRenderer.invoke('host:remove', data),
  },
  access: {
    list: () => ipcRenderer.invoke('access:list'),
    clear: () => ipcRenderer.invoke('access:clear'),
  },
  wol: {
    localNics: () => ipcRenderer.invoke('wol:localNics'),
    list: () => ipcRenderer.invoke('wol:list'),
    saveTarget: (data) => ipcRenderer.invoke('wol:saveTarget', data),
    removeTarget: (data) => ipcRenderer.invoke('wol:removeTarget', data),
    send: (data) => ipcRenderer.invoke('wol:send', data),
  },
  sync: {
    state: () => ipcRenderer.invoke('sync:state'),
    addTask: (patch) => ipcRenderer.invoke('sync:task:add', patch),
    invite: (id) => ipcRenderer.invoke('sync:task:invite', id),
    updateTask: (id, patch) => ipcRenderer.invoke('sync:task:update', { id, patch }),
    removeTask: (id) => ipcRenderer.invoke('sync:task:remove', id),
    start: (id) => ipcRenderer.invoke('sync:task:start', id),
    stop: (id) => ipcRenderer.invoke('sync:task:stop', id),
    runNow: (id) => ipcRenderer.invoke('sync:task:runNow', id),
    resetIndex: (id) => ipcRenderer.invoke('sync:task:resetIndex', id),
    trash: (id) => ipcRenderer.invoke('sync:task:trash', id),
    restore: (id, data) => ipcRenderer.invoke('sync:task:restore', { id, ...data }),
    purgeTrash: (id, opts) => ipcRenderer.invoke('sync:task:purgeTrash', { id, ...opts }),
    pickDir: () => ipcRenderer.invoke('sync:pickDir'),
    listDir: (dir) => ipcRenderer.invoke('sync:listDir', dir),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('sync:state', listener);
      return () => ipcRenderer.removeListener('sync:state', listener);
    },
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
