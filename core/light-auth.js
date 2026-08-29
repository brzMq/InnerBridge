/* global module, require, Buffer */
const crypto = require('crypto');
const TTL_MS = 5 * 60 * 1000;
function createChallenge({ deviceId, requesterId, now = Date.now(), ttlMs = TTL_MS } = {}) {
  if (!deviceId || !requesterId) throw new Error('认证挑战参数无效');
  return { protocol: 'innernet-auth', version: 1, challengeId: `auth_${crypto.randomBytes(16).toString('hex')}`, deviceId: String(deviceId), requesterId: String(requesterId), nonce: crypto.randomBytes(32).toString('base64url'), issuedAt: now, expiresAt: now + ttlMs };
}
function signChallenge(challenge, privateKey) {
  if (!challenge?.challengeId || !privateKey) throw new Error('认证签名参数无效');
  return { challenge, signature: crypto.sign(null, Buffer.from(JSON.stringify(challenge)), privateKey).toString('base64') };
}
function verifyChallenge(signed, publicKey, expected = {}, now = Date.now()) {
  const c = signed?.challenge;
  if (!c || c.protocol !== 'innernet-auth' || c.expiresAt <= now || c.deviceId !== expected.deviceId || c.requesterId !== expected.requesterId) return false;
  try { return crypto.verify(null, Buffer.from(JSON.stringify(c)), publicKey, Buffer.from(String(signed.signature || ''), 'base64')); } catch { return false; }
}
module.exports = { TTL_MS, createChallenge, signChallenge, verifyChallenge };
