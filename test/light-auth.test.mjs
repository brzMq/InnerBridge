import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChallenge, signChallenge, verifyChallenge } = require('../core/light-auth');
test('轻量认证挑战绑定设备并验证签名', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const challenge = createChallenge({ deviceId: 'win-device', requesterId: 'mac-device', now: 1000 });
  const signed = signChallenge(challenge, pair.privateKey);
  assert.equal(verifyChallenge(signed, pair.publicKey, { deviceId: 'win-device', requesterId: 'mac-device' }, 1001), true);
  assert.equal(verifyChallenge(signed, pair.publicKey, { deviceId: 'other', requesterId: 'mac-device' }, 1001), false);
});
test('轻量认证拒绝过期和篡改挑战', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const challenge = createChallenge({ deviceId: 'win-device', requesterId: 'mac-device', now: 1000, ttlMs: 10 });
  const signed = signChallenge(challenge, pair.privateKey);
  assert.equal(verifyChallenge(signed, pair.publicKey, { deviceId: 'win-device', requesterId: 'mac-device' }, 1011), false);
  signed.challenge.requesterId = 'attacker';
  assert.equal(verifyChallenge(signed, pair.publicKey, { deviceId: 'win-device', requesterId: 'mac-device' }, 1001), false);
});
