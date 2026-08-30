/**
 * 撤销端点的集成测试：一方解除信任时，对端能否收到并验签通过。
 *
 * 要覆盖的核心场景是「A 解除了 B，B 必须知道」。此前 unpair 只删本机凭据，
 * 对端会一直停留在「已信任」的假象上，直到某个操作被拒才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startPairingServer } = require('../electron/security/pairing-service');
const { createCredentialStore } = require('../core/credential-store');
const { createRevocation, signRevocation } = require('../core/revocation');

const WIN = 'dev_win0000000000000000000000000000';
const MAC = 'dev_mac0000000000000000000000000000';

/**
 * 起一台「接收撤销」的设备（角色：Windows）。
 * trusted 里放着已配对设备的公钥 —— 与 electron/main.js 的 lookupTrustedPublicKey 一致。
 */
async function startReceiver({ keys, revoked } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-net-revoke-'));
  const store = createCredentialStore(path.join(tempDir, 'trusted-devices.json'));
  store.set(MAC, JSON.stringify({ fingerprint: 'sha256:mac', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }));
  const service = await startPairingServer({
    port: 0,
    deviceId: WIN,
    identityFingerprint: 'sha256:win',
    lookupTrustedPublicKey: (deviceId) => {
      try { return JSON.parse(store.get(String(deviceId || '')) || '{}').publicKey || null; } catch { return null; }
    },
    onRevoked: ({ deviceId, deviceName }) => { store.remove(String(deviceId)); revoked?.push({ deviceId, deviceName }); return { ok: true }; },
  });
  return {
    url: `http://127.0.0.1:${service.port}`,
    store,
    close: async () => { await new Promise((resolve) => service.server.close(resolve)); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

const postRevoke = (url, signed) =>
  fetch(`${url}/api/pair/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signed }),
  });

test('已配对设备送达的撤销凭据被接受，双方凭据都被清掉', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const revoked = [];
  const receiver = await startReceiver({ keys, revoked });
  try {
    const signed = signRevocation(createRevocation({ deviceId: MAC, deviceName: 'BrZ-Mac', targetDeviceId: WIN }), keys.privateKey);
    const response = await postRevoke(receiver.url, signed);
    assert.equal(response.status, 200);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].deviceId, MAC);
    assert.equal(revoked[0].deviceName, 'BrZ-Mac');
    // 对端凭据已被删除，本机不会再认为它可信
    assert.equal(receiver.store.get(MAC), null);
  } finally {
    await receiver.close();
  }
});

test('未配对设备发来的撤销被拒，不会改动任何凭据', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const stranger = crypto.generateKeyPairSync('ed25519');
  const revoked = [];
  const receiver = await startReceiver({ keys, revoked });
  try {
    const signed = signRevocation(
      createRevocation({ deviceId: 'dev_stranger0000000000000000000000', targetDeviceId: WIN }),
      stranger.privateKey
    );
    const response = await postRevoke(receiver.url, signed);
    assert.equal(response.status, 403);
    assert.equal(revoked.length, 0);
    assert.ok(receiver.store.get(MAC));
  } finally {
    await receiver.close();
  }
});

test('冒名私钥签发的撤销被拒（防止第三方拆散配对）', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const impostor = crypto.generateKeyPairSync('ed25519');
  const revoked = [];
  const receiver = await startReceiver({ keys, revoked });
  try {
    // 声称自己是已配对的 MAC，但用别人的私钥签名
    const signed = signRevocation(createRevocation({ deviceId: MAC, targetDeviceId: WIN }), impostor.privateKey);
    const response = await postRevoke(receiver.url, signed);
    assert.equal(response.status, 403);
    assert.equal(revoked.length, 0);
    assert.ok(receiver.store.get(MAC));
  } finally {
    await receiver.close();
  }
});

test('发给别的设备的撤销被拒（targetDeviceId 不符）', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const revoked = [];
  const receiver = await startReceiver({ keys, revoked });
  try {
    const signed = signRevocation(createRevocation({ deviceId: MAC, targetDeviceId: 'dev_other00000000000000000000000' }), keys.privateKey);
    const response = await postRevoke(receiver.url, signed);
    assert.equal(response.status, 403);
    assert.equal(revoked.length, 0);
  } finally {
    await receiver.close();
  }
});

test('过期的撤销被拒，防止旧凭据被重放', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const revoked = [];
  const receiver = await startReceiver({ keys, revoked });
  try {
    const signed = signRevocation(createRevocation({ deviceId: MAC, targetDeviceId: WIN, ttlMs: -1 }), keys.privateKey);
    const response = await postRevoke(receiver.url, signed);
    assert.equal(response.status, 403);
    assert.equal(revoked.length, 0);
  } finally {
    await receiver.close();
  }
});

test('请求体非法时返回 400 而不是崩溃', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const receiver = await startReceiver({ keys });
  try {
    const bad = await fetch(`${receiver.url}/api/pair/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' });
    assert.equal(bad.status, 400);
    const empty = await postRevoke(receiver.url, null);
    assert.equal(empty.status, 403);
  } finally {
    await receiver.close();
  }
});
