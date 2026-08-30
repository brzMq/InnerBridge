/* global module, require, Buffer */
const crypto = require('crypto');
const PROTOCOL = 'innernet-revocation';
const PROTOCOL_VERSION = 1;
const TTL_MS = 5 * 60 * 1000;

/**
 * 撤销凭据：一方解除信任时用它通知对端。
 *
 * 与共享清单的挑战/响应不同，这里不需要先取一次挑战 —— 凭据自带 issuedAt/expiresAt，
 * 重放的危害被 TTL 兜住，且「删除一条已不存在的凭据」是幂等的。
 * 但必须签名：否则局域网内任何人都能伪造撤销把两端的配对拆掉。
 */
function createRevocation({ deviceId, deviceName = '', targetDeviceId, now = Date.now(), ttlMs = TTL_MS } = {}) {
  if (!deviceId || !targetDeviceId) throw new Error('撤销参数无效');
  return {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    revocationId: `rev_${crypto.randomBytes(16).toString('hex')}`,
    deviceId: String(deviceId),
    deviceName: String(deviceName).slice(0, 80),
    targetDeviceId: String(targetDeviceId),
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
}

function signRevocation(revocation, privateKey) {
  if (!revocation?.revocationId || !privateKey) throw new Error('撤销签名参数无效');
  return { revocation, signature: crypto.sign(null, Buffer.from(JSON.stringify(revocation)), privateKey).toString('base64') };
}

function verifyRevocation(signed, publicKey, expected = {}, now = Date.now()) {
  const r = signed?.revocation;
  if (!r || r.protocol !== PROTOCOL || r.version !== PROTOCOL_VERSION) return false;
  if (!/^rev_[a-f0-9]{32}$/.test(String(r.revocationId || ''))) return false;
  if (!Number.isFinite(r.expiresAt) || r.expiresAt <= now) return false;
  if (expected.targetDeviceId && r.targetDeviceId !== expected.targetDeviceId) return false;
  if (expected.deviceId && r.deviceId !== expected.deviceId) return false;
  try {
    const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
    return crypto.verify(null, Buffer.from(JSON.stringify(r)), key, Buffer.from(String(signed.signature || ''), 'base64'));
  } catch {
    return false;
  }
}

module.exports = { PROTOCOL, PROTOCOL_VERSION, TTL_MS, createRevocation, signRevocation, verifyRevocation };
