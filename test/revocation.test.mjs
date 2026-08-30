import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRevocation, signRevocation, verifyRevocation, TTL_MS } = require('../core/revocation.js');

const WIN = 'dev_win0000000000000000000000000000';
const MAC = 'dev_mac0000000000000000000000000000';

const keys = () => crypto.generateKeyPairSync('ed25519');

test('撤销凭据能被对端用留存公钥验签通过', () => {
  const pair = keys();
  const signed = signRevocation(createRevocation({ deviceId: WIN, deviceName: 'BrZ-PC', targetDeviceId: MAC, now: 1000 }), pair.privateKey);
  assert.equal(verifyRevocation(signed, pair.publicKey, { targetDeviceId: MAC }, 1001), true);
});

test('撤销凭据绑定收发双方，换任一端都失效', () => {
  const pair = keys();
  const signed = signRevocation(createRevocation({ deviceId: WIN, targetDeviceId: MAC, now: 1000 }), pair.privateKey);
  assert.equal(verifyRevocation(signed, pair.publicKey, { targetDeviceId: 'dev_other00000000000000000000000' }, 1001), false);
  assert.equal(verifyRevocation(signed, pair.publicKey, { deviceId: 'dev_other00000000000000000000000', targetDeviceId: MAC }, 1001), false);
});

test('冒名私钥签发的撤销被拒', () => {
  const real = keys();
  const impostor = keys();
  const signed = signRevocation(createRevocation({ deviceId: WIN, targetDeviceId: MAC, now: 1000 }), impostor.privateKey);
  assert.equal(verifyRevocation(signed, real.publicKey, { targetDeviceId: MAC }, 1001), false);
});

test('过期撤销被拒，防止旧凭据被重放', () => {
  const pair = keys();
  const signed = signRevocation(createRevocation({ deviceId: WIN, targetDeviceId: MAC, now: 1000, ttlMs: 10 }), pair.privateKey);
  assert.equal(verifyRevocation(signed, pair.publicKey, { targetDeviceId: MAC }, 1011), false);
  assert.equal(verifyRevocation(signed, pair.publicKey, { targetDeviceId: MAC }, 1005), true);
  assert.equal(TTL_MS, 5 * 60 * 1000);
});

test('篡改撤销内容的任何字段都验签失败', () => {
  const pair = keys();
  const signed = signRevocation(createRevocation({ deviceId: WIN, deviceName: 'BrZ-PC', targetDeviceId: MAC, now: 1000 }), pair.privateKey);
  for (const mutate of [
    (s) => { s.revocation.deviceName = 'Evil'; },
    (s) => { s.revocation.expiresAt = s.revocation.expiresAt + 999999; },
    (s) => { s.revocation.targetDeviceId = MAC; s.revocation.issuedAt = 0; },
  ]) {
    const copy = JSON.parse(JSON.stringify(signed));
    mutate(copy);
    assert.equal(verifyRevocation(copy, pair.publicKey, { targetDeviceId: MAC }, 1001), false);
  }
});

test('协议名或 revocationId 不合法时直接拒绝', () => {
  const pair = keys();
  const signed = signRevocation(createRevocation({ deviceId: WIN, targetDeviceId: MAC, now: 1000 }), pair.privateKey);
  const badProtocol = JSON.parse(JSON.stringify(signed));
  badProtocol.revocation.protocol = 'something-else';
  assert.equal(verifyRevocation(badProtocol, pair.publicKey, { targetDeviceId: MAC }, 1001), false);
  const badId = JSON.parse(JSON.stringify(signed));
  badId.revocation.revocationId = 'nope';
  assert.equal(verifyRevocation(badId, pair.publicKey, { targetDeviceId: MAC }, 1001), false);
});

test('缺参、空签名、坏公钥都不会抛异常', () => {
  const pair = keys();
  assert.equal(verifyRevocation(null, pair.publicKey, {}, 1000), false);
  assert.equal(verifyRevocation({}, pair.publicKey, {}, 1000), false);
  assert.equal(verifyRevocation({ revocation: createRevocation({ deviceId: WIN, targetDeviceId: MAC }) }, pair.publicKey, {}, 1000), false);
  assert.throws(() => createRevocation({ deviceId: WIN }));
  assert.throws(() => createRevocation({ targetDeviceId: MAC }));
  assert.throws(() => signRevocation(createRevocation({ deviceId: WIN, targetDeviceId: MAC }), null));
});
