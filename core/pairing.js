/* global module, require */
const crypto = require('crypto');
const STATES = ['idle', 'pending', 'accepted', 'rejected', 'expired', 'failed'];
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function generateCode(randomInt = crypto.randomInt) { return String(randomInt(100000, 1000000)); }
function createPairingSession(localDeviceId, remoteDeviceId, now = Date.now()) { return { sessionId: `pair_${crypto.randomBytes(12).toString('hex')}`, localDeviceId, remoteDeviceId, code: generateCode(), state: 'pending', attempts: 0, createdAt: now, expiresAt: now + CODE_TTL_MS }; }
function verifyPairingCode(session, code, now = Date.now()) {
  if (!session || session.state !== 'pending') return { ok: false, reasonCode: 'INVALID_STATE' };
  if (now >= session.expiresAt) return { ok: false, reasonCode: 'EXPIRED', session: { ...session, state: 'expired', code: undefined } };
  const attempts = session.attempts + 1;
  if (attempts > MAX_ATTEMPTS) return { ok: false, reasonCode: 'TOO_MANY_ATTEMPTS', session: { ...session, state: 'failed', attempts, code: undefined } };
  if (String(code) !== session.code) return { ok: false, reasonCode: 'CODE_MISMATCH', session: { ...session, attempts } };
  return { ok: true, session: { ...session, state: 'accepted', attempts, code: undefined } };
}
function trustIdentity(device, fingerprint, now = Date.now()) { if (!fingerprint) throw new Error('fingerprint required'); return { ...device, trust: { state: 'trusted', pairedAt: device.trust?.pairedAt || new Date(now).toISOString(), lastVerifiedAt: new Date(now).toISOString() }, identity: { ...(device.identity || {}), fingerprint } }; }
function revokeTrust(device) { return { ...device, trust: { state: 'unpaired', pairedAt: null, lastVerifiedAt: null } }; }
module.exports = { STATES, CODE_TTL_MS, MAX_ATTEMPTS, generateCode, createPairingSession, verifyPairingCode, trustIdentity, revokeTrust };
