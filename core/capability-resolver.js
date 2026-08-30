/* global require, module, process */
const { normalizeDevice } = require('./device-schema');

const REASONS = { PLATFORM_NOT_SUPPORTED: '当前平台不支持此能力', NOT_CONFIGURED: '尚未完成配置', SERVICE_UNAVAILABLE: '相关服务当前不可用', NOT_TRUSTED: '设备尚未配对信任' };
const TRUST_REQUIRED = new Set(['fileSend', 'fileReceive', 'smbShare', 'smbMount', 'shareSync', 'wolTarget']);

function resolveCapabilities({ platform = process.platform, config = {}, services = {}, trusted = false } = {}) {
  const win = platform === 'win32'; const mac = platform === 'darwin';
  const supported = { chat: true, fileSend: true, fileReceive: true, smbShare: win, smbMount: mac, shareSync: true, wolSender: true, wolTarget: true };
  const result = {};
  for (const [name, isSupported] of Object.entries(supported)) {
    const configured = isSupported && config[name] !== false;
    const serviceOk = services[name] !== false;
    const available = isSupported && configured && serviceOk && (!TRUST_REQUIRED.has(name) || trusted);
    let reasonCode;
    if (!isSupported) reasonCode = 'PLATFORM_NOT_SUPPORTED'; else if (!configured) reasonCode = 'NOT_CONFIGURED'; else if (!serviceOk) reasonCode = 'SERVICE_UNAVAILABLE'; else if (!available) reasonCode = 'NOT_TRUSTED';
    result[name] = { supported: isSupported, configured, available, verified: Boolean(config[`${name}.verified`]), ...(reasonCode ? { reasonCode } : {}) };
  }
  return result;
}

function buildLocalDevice(details = {}) {
  return normalizeDevice({ ...details, capabilities: resolveCapabilities({ ...details, services: details.capabilityServices || details.services }) });
}

/**
 * 发现公告兼容层：新版直接携带 available/reasonCode；旧版只有 supported/configured。
 * 接收端始终按“本机是否信任对端”重新计算敏感能力，不能直接相信对端自报的可用状态。
 */
function resolveAdvertisedCapabilities(device = {}, trusted = false) {
  const announced = device.capabilities || {};
  const config = {};
  const services = {};
  for (const [name, value] of Object.entries(announced)) {
    config[name] = value?.configured !== false;
    config[`${name}.verified`] = Boolean(value?.verified);
    services[name] = value?.reasonCode === 'SERVICE_UNAVAILABLE'
      ? false
      : typeof value?.available === 'boolean'
        ? value.available || value.reasonCode === 'NOT_TRUSTED'
        : value?.configured !== false;
  }
  return resolveCapabilities({ platform: device.platform, config, services, trusted });
}

module.exports = { REASONS, resolveCapabilities, resolveAdvertisedCapabilities, buildLocalDevice };
