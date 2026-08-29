/* global module, require */
const { createPairMessage, validatePairMessage } = require('./pairing-protocol');

function createPairingRelay({ now = () => Date.now(), ttlMs = 5 * 60 * 1000 } = {}) {
  const sessions = new Map();
  return {
    publish(session) { sessions.set(session.sessionId, { session, expiresAt: now() + ttlMs }); return createPairMessage('pair_request', session); },
    consume(sessionId, deviceId) { const current = now(); for (const [id, item] of sessions) if (current >= item.expiresAt) sessions.delete(id); const item = sessions.get(sessionId); if (!item) return { ok: false, reasonCode: 'EXPIRED' }; if (item.session.remoteDeviceId !== deviceId) return { ok: false, reasonCode: 'RECIPIENT_MISMATCH' }; sessions.delete(sessionId); return { ok: true, message: createPairMessage('pair_challenge', item.session) }; },
    size() { return sessions.size; },
    validate(message, deviceId) { return validatePairMessage(message, deviceId); },
  };
}
module.exports = { createPairingRelay };
