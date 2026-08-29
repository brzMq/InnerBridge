/* global require, module, process */
const { normalizeDevice } = require('./device-schema');

const REASONS = { PLATFORM_NOT_SUPPORTED: '当前平台不支持此能力', NOT_CONFIGURED: '尚未完成配置', SERVICE_UNAVAILABLE: '相关服务当前不可用', NOT_TRUSTED: '设备尚未配对信任' };

function resolveCapabilities({ platform = process.platform, config = {}, services = {}, trusted = false } = {}) {
  const win = platform === 'win32'; const mac = platform === 'darwin';
  const supported = { chat: true, fileSend: true, fileReceive: true, smbShare: win, smbMount: mac, shareSync: true, wolSender: true, wolTarget: true };
  const result = {};
  for (const [name, isSupported] of Object.entries(supported)) {
    const configured = isSupported && config[name] !== false;
    const serviceOk = services[name] !== false;
    const available = isSupported && configured && serviceOk && (['fileSend', 'fileReceive', 'smbShare', 'smbMount', 'wolTarget'].includes(name) ? trusted || name === 'chat' : true);
    let reasonCode;
    if (!isSupported) reasonCode = 'PLATFORM_NOT_SUPPORTED'; else if (!configured) reasonCode = 'NOT_CONFIGURED'; else if (!serviceOk) reasonCode = 'SERVICE_UNAVAILABLE'; else if (!available) reasonCode = 'NOT_TRUSTED';
    result[name] = { supported: isSupported, configured, available, verified: Boolean(config[`${name}.verified`]), ...(reasonCode ? { reasonCode } : {}) };
  }
  return result;
}

function buildLocalDevice(details = {}) { return normalizeDevice({ ...details, capabilities: resolveCapabilities(details) }); }

module.exports = { REASONS, resolveCapabilities, buildLocalDevice };
