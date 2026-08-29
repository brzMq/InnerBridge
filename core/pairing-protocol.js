/* global module, require */
const crypto = require('crypto');
const PROTOCOL_VERSION = 1;
const MESSAGE_TYPES = ['pair_request', 'pair_challenge', 'pair_confirm', 'pair_reject'];
function createPairMessage(type, session, extra = {}) {
  if (!MESSAGE_TYPES.includes(type) || !session?.sessionId || !session.localDeviceId || !session.remoteDeviceId) throw new Error('invalid pairing message');
  return { protocol: 'innernet-pairing', protocolVersion: PROTOCOL_VERSION, type, messageId: `pm_${crypto.randomBytes(12).toString('hex')}`, sessionId: session.sessionId, fromDeviceId: session.localDeviceId, toDeviceId: session.remoteDeviceId, createdAt: Date.now(), ...extra };
}
function validatePairMessage(message, expectedDeviceId) {
  if (!message || message.protocol !== 'innernet-pairing' || message.protocolVersion !== PROTOCOL_VERSION || !MESSAGE_TYPES.includes(message.type)) return { valid: false, reasonCode: 'PROTOCOL_INVALID' };
  if (expectedDeviceId && message.toDeviceId !== expectedDeviceId) return { valid: false, reasonCode: 'RECIPIENT_MISMATCH' };
  if (!/^pair_[a-f0-9]{24}$/.test(message.sessionId) || !/^pm_[a-f0-9]{24}$/.test(message.messageId)) return { valid: false, reasonCode: 'IDENTIFIER_INVALID' };
  return { valid: true };
}
function createAuthorization(session, deviceId, now = Date.now()) { return { authorizationId: `auth_${crypto.randomBytes(16).toString('hex')}`, sessionId: session.sessionId, deviceId, issuedAt: now, expiresAt: now + 10 * 60 * 1000 }; }
function isAuthorizationValid(auth, deviceId, now = Date.now()) { return Boolean(auth && auth.deviceId === deviceId && now < auth.expiresAt); }
module.exports = { PROTOCOL_VERSION, MESSAGE_TYPES, createPairMessage, validatePairMessage, createAuthorization, isAuthorizationValid };
