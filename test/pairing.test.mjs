import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPairingSession, verifyPairingCode, trustIdentity, revokeTrust, MAX_ATTEMPTS } = require('../core/pairing');
test('配对码成功后一次性失效并绑定可信身份', () => { const s = createPairingSession('a', 'b', 1000); const r = verifyPairingCode(s, s.code, 1001); assert.equal(r.ok, true); assert.equal(r.session.code, undefined); const d = trustIdentity({ deviceId: 'b', trust: { state: 'unpaired' } }, 'sha256:x', 1001); assert.equal(d.trust.state, 'trusted'); assert.equal(revokeTrust(d).trust.state, 'unpaired'); });
test('配对码错误、超时和暴力尝试均受限', () => { let s = createPairingSession('a', 'b', 1000); for (let i = 0; i < MAX_ATTEMPTS; i++) { const r = verifyPairingCode(s, '000000', 1001); s = r.session; } assert.equal(verifyPairingCode(s, '000000', 1001).reasonCode, 'TOO_MANY_ATTEMPTS'); const expired = verifyPairingCode(createPairingSession('a', 'b', 1000), '123456', 301001); assert.equal(expired.reasonCode, 'EXPIRED'); });
