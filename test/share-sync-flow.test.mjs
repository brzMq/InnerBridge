/**
 * 端到端回归：配对落库 → 挑战签发 → 私钥签名 → 验签 → 返回清单。
 *
 * 这条链路曾经断过两次：一是 verifyShareAuth 从未注入导致路由不注册（404），
 * 二是配对时存下的 publicKey 没有任何地方读取。这里用真实的 credential-store
 * 和 chat-server 串起来，任何一环再断都会在这里失败。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startChatServer } = require('../electron/chat-server.js');
const { createCredentialStore } = require('../core/credential-store.js');
const { createChallenge, signChallenge, verifyChallenge } = require('../core/light-auth.js');

const WIN_DEVICE_ID = 'dev_win0000000000000000000000000000';
const MAC_DEVICE_ID = 'dev_mac0000000000000000000000000000';

let tempDir;
let macKeys;
let store;
let server;
let macPrivateKeyPem;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-net-sync-flow-'));
  macKeys = crypto.generateKeyPairSync('ed25519');
  macPrivateKeyPem = macKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  store = createCredentialStore(path.join(tempDir, 'trusted-devices.json'));

  // 模拟 Windows 端 pairing:confirmIncoming 落库（electron/main.js 的写入形状）
  store.set(
    MAC_DEVICE_ID,
    JSON.stringify({
      authorization: 'paired',
      fingerprint: 'sha256:fake',
      publicKey: macKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    })
  );

  // 与 electron/main.js startChat() 中的注入逻辑保持一致
  server = await startChatServer(0, {
    host: '127.0.0.1',
    file: path.join(tempDir, 'messages.jsonl'),
    imagesDir: path.join(tempDir, 'images'),
    filesDir: path.join(tempDir, 'files'),
    issueShareChallenge: (requesterId) => {
      const saved = JSON.parse(store.get(String(requesterId || '')) || '{}');
      if (!saved.publicKey) return null;
      return createChallenge({ deviceId: WIN_DEVICE_ID, requesterId });
    },
    verifyShareAuth: (signed, requesterId) => {
      const saved = JSON.parse(store.get(String(requesterId || '')) || '{}');
      if (!saved.publicKey) return false;
      try {
        return verifyChallenge(signed, crypto.createPublicKey(saved.publicKey), {
          deviceId: WIN_DEVICE_ID,
          requesterId,
        });
      } catch {
        return false;
      }
    },
    shareManifest: () => [
      { shareName: 'Public', account: 'share', unified: true },
      { shareName: 'Media', account: 'share', unified: true },
    ],
  });
});

after(async () => {
  if (server?.server) await new Promise((resolve) => server.server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

/** 复刻 electron/main.js 中 share:apiPull 的两步请求 */
async function apiPull(requesterId = MAC_DEVICE_ID, privateKeyPem = macPrivateKeyPem) {
  const post = async (url, payload) => {
    const response = await fetch(`${server.url}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const challenge = await post('/api/shares/challenge', { requesterId });
  if (challenge.status !== 200) return challenge;
  const signed = signChallenge(challenge.body, privateKeyPem);
  return post('/api/shares/manifest', { signed, requesterId });
}

test('配对完成后 Mac 能凭本机私钥取到完整清单', async () => {
  const result = await apiPull();
  assert.equal(result.status, 200);
  assert.equal(result.body.shares.length, 2);
  assert.deepEqual(
    result.body.shares.map((s) => s.shareName),
    ['Public', 'Media']
  );
});

test('清单不含 password 字段（明文口令不外泄）', async () => {
  const result = await apiPull();
  for (const share of result.body.shares) {
    assert.equal('password' in share, false);
    assert.equal('dirPath' in share, false);
  }
});

test('解除配对后立刻取不到挑战', async () => {
  const backup = store.get(MAC_DEVICE_ID);
  store.remove(MAC_DEVICE_ID);
  try {
    const result = await apiPull();
    assert.equal(result.status, 403);
  } finally {
    store.set(MAC_DEVICE_ID, backup);
  }
});

test('配对记录里只有指纹没有公钥时（旧数据）拒绝服务', async () => {
  const backup = store.get(MAC_DEVICE_ID);
  // 2.0 早期只在 credential store 里存了 fingerprint，没有 publicKey
  store.set(MAC_DEVICE_ID, JSON.stringify({ authorization: 'paired', fingerprint: 'sha256:fake' }));
  try {
    const result = await apiPull();
    assert.equal(result.status, 403);
  } finally {
    store.set(MAC_DEVICE_ID, backup);
  }
});
