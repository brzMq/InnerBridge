/* global module, require */
const { createPairingSession, verifyPairingCode, trustIdentity } = require('./pairing');
const { createAuthorization } = require('./pairing-protocol');

function createPairingCoordinator({ now = () => Date.now() } = {}) {
  const sessions = new Map();
  return {
    request(fromDeviceId, toDeviceId) { const session = createPairingSession(fromDeviceId, toDeviceId, now()); sessions.set(session.sessionId, session); return { sessionId: session.sessionId, code: session.code, expiresAt: session.expiresAt, fromDeviceId, toDeviceId }; },
    confirm(sessionId, toDeviceId, code, fingerprint) { const current = sessions.get(sessionId); if (!current || current.remoteDeviceId !== toDeviceId) return { ok: false, reasonCode: 'RECIPIENT_MISMATCH' }; const result = verifyPairingCode(current, code, now()); if (!result.ok) { if (result.session?.state === 'pending') sessions.set(sessionId, result.session); else sessions.delete(sessionId); return { ok: false, reasonCode: result.reasonCode }; } sessions.delete(sessionId); const authorization = createAuthorization(result.session, toDeviceId, now()); return { ok: true, authorization, trustedIdentity: trustIdentity({ deviceId: toDeviceId, trust: { state: 'unpaired' } }, fingerprint, now()) }; },
    pendingCount() { return sessions.size; },
  };
}
module.exports = { createPairingCoordinator };
