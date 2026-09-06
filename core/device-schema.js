/* global require, module */
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const CAPABILITY_NAMES = ['chat', 'fileSend', 'fileReceive', 'smbShare', 'smbMount', 'shareSync', 'wolSender', 'wolTarget'];

function createDeviceId(randomBytes = crypto.randomBytes(16)) {
  return `dev_${randomBytes.toString('hex')}`;
}

function normalizeCapability(value = {}) {
  return {
    supported: Boolean(value.supported), configured: Boolean(value.configured),
    available: Boolean(value.available), verified: Boolean(value.verified),
    ...(value.reasonCode ? { reasonCode: String(value.reasonCode) } : {}),
  };
}

function normalizeDevice(input = {}) {
  const d = input || {};
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) capabilities[name] = normalizeCapability(d.capabilities?.[name]);
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: String(d.deviceId || createDeviceId()),
    deviceName: String(d.deviceName || d.hostname || '未命名设备').slice(0, 80),
    hostname: d.hostname ? String(d.hostname).slice(0, 255) : '',
    platform: String(d.platform || 'unknown'),
    platformVersion: d.platformVersion ? String(d.platformVersion) : '',
    deviceType: String(d.deviceType || 'unknown'),
    app: { name: 'InnerBridge', version: String(d.app?.version || '0.2.0'), protocolVersion: Number(d.app?.protocolVersion || 1) },
    identity: { publicKey: String(d.identity?.publicKey || ''), fingerprint: String(d.identity?.fingerprint || '') },
    network: { addresses: Array.isArray(d.network?.addresses) ? d.network.addresses : [], preferredAddress: String(d.network?.preferredAddress || '') },
    presence: { online: Boolean(d.presence?.online), firstSeenAt: d.presence?.firstSeenAt || null, lastSeenAt: d.presence?.lastSeenAt || null, source: String(d.presence?.source || 'local') },
    trust: { state: ['unpaired', 'pairing', 'trusted', 'identity_changed'].includes(d.trust?.state) ? d.trust.state : 'unpaired', pairedAt: d.trust?.pairedAt || null, lastVerifiedAt: d.trust?.lastVerifiedAt || null },
    services: d.services && typeof d.services === 'object' ? d.services : {},
    capabilities,
  };
}

function validateDevice(device) {
  const errors = [];
  if (!device || device.schemaVersion !== SCHEMA_VERSION) errors.push('SCHEMA_VERSION_INVALID');
  if (!/^dev_[a-f0-9]{32}$/.test(device?.deviceId || '')) errors.push('DEVICE_ID_INVALID');
  if (!device?.platform) errors.push('PLATFORM_MISSING');
  for (const name of CAPABILITY_NAMES) for (const key of ['supported', 'configured', 'available', 'verified']) if (typeof device?.capabilities?.[name]?.[key] !== 'boolean') errors.push(`CAPABILITY_${name}_${key}_INVALID`);
  return { valid: errors.length === 0, errors };
}

function migrateDevice(input = {}) { return normalizeDevice({ ...input, schemaVersion: SCHEMA_VERSION }); }

module.exports = { SCHEMA_VERSION, CAPABILITY_NAMES, createDeviceId, normalizeDevice, validateDevice, migrateDevice };
