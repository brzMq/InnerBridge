import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startChatServer } = require('../electron/chat-server.js');
const { createChallenge, signChallenge, verifyChallenge } = require('../core/light-auth.js');

const WIN_DEVICE_ID = 'dev_win0000000000000000000000000000';
const MAC_DEVICE_ID = 'dev_mac0000000000000000000000000000';

let tempDirs = [];
let trusted;
let macKeys;
let impostorKeys;
let wired;
let bare;

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-net-manifest-test-'));
  tempDirs.push(dir);
  return {
    host: '127.0.0.1',
    file: path.join(dir, 'messages.jsonl'),
    imagesDir: path.join(dir, 'images'),
    filesDir: path.join(dir, 'files'),
  };
}

before(async () => {
  macKeys = crypto.generateKeyPairSync('ed25519');
  impostorKeys = crypto.generateKeyPairSync('ed25519');
  trusted = new Map([
    [MAC_DEVICE_ID, macKeys.publicKey.export({ type: 'spki', format: 'pem' })],
  ]);

  // 完整接线：与 electron/main.js 的 startChat() 注入方式保持一致
  wired = await startChatServer(0, {
    ...makeTempDir(),
    issueShareChallenge: (requesterId) =>
      trusted.has(String(requesterId))
        ? createChallenge({ deviceId: WIN_DEVICE_ID, requesterId })
        : null,
    verifyShareAuth: (signed, requesterId) => {
      const publicKey = trusted.get(String(requesterId));
      if (!publicKey) return false;
      try {
        return verifyChallenge(signed, crypto.createPublicKey(publicKey), {
          deviceId: WIN_DEVICE_ID,
          requesterId,
        });
      } catch {
        return false;
      }
    },
    shareManifest: () => [{ shareName: 'Public', account: 'share', unified: true }],
  });

  // 未接线：主进程忘了注入校验器时的行为（历史上这个状态会静默返回 404）
  bare = await startChatServer(0, {
    ...makeTempDir(),
    shareManifest: () => [{ shareName: 'Public', account: 'share', unified: true }],
  });
});

after(async () => {
  for (const info of [wired, bare]) {
    if (info && info.server) await new Promise((resolve) => info.server.close(resolve));
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

async function postJson(base, url, payload) {
  const response = await fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function pullManifest(base, requesterId, privateKey = macKeys.privateKey) {
  const challenge = await postJson(base, '/api/shares/challenge', { requesterId });
  if (challenge.status !== 200) return challenge;
  const signed = signChallenge(challenge.body, privateKey);
  return postJson(base, '/api/shares/manifest', { signed, requesterId });
}

test('已配对设备凭 Ed25519 签名可取到共享清单', async () => {
  const result = await pullManifest(wired.url, MAC_DEVICE_ID);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.shares, [{ shareName: 'Public', account: 'share', unified: true }]);
});

test('清单只含挂载字段，绝不外发 password 与 dirPath', async () => {
  const result = await pullManifest(wired.url, MAC_DEVICE_ID);
  for (const share of result.body.shares) {
    assert.deepEqual(Object.keys(share).sort(), ['account', 'shareName', 'unified']);
  }
});

test('未配对设备取不到挑战', async () => {
  const stranger = 'dev_stranger00000000000000000000000';
  const result = await postJson(wired.url, '/api/shares/challenge', { requesterId: stranger });
  assert.equal(result.status, 403);
});

test('冒名私钥签名被拒', async () => {
  const result = await pullManifest(wired.url, MAC_DEVICE_ID, impostorKeys.privateKey);
  assert.equal(result.status, 403);
});

test('已配对设备之间不能互相冒用：换 requesterId 提交无效', async () => {
  const challenge = await postJson(wired.url, '/api/shares/challenge', { requesterId: MAC_DEVICE_ID });
  assert.equal(challenge.status, 200);
  const signed = signChallenge(challenge.body, macKeys.privateKey);
  // 签名有效，但声称自己是另一个（未配对）设备
  const result = await postJson(wired.url, '/api/shares/manifest', {
    signed,
    requesterId: 'dev_other00000000000000000000000000',
  });
  assert.equal(result.status, 403);
});

test('挑战被篡改后签名校验失败', async () => {
  const challenge = await postJson(wired.url, '/api/shares/challenge', { requesterId: MAC_DEVICE_ID });
  const signed = signChallenge(challenge.body, macKeys.privateKey);
  signed.challenge.nonce = 'tampered';
  const result = await postJson(wired.url, '/api/shares/manifest', {
    signed,
    requesterId: MAC_DEVICE_ID,
  });
  assert.equal(result.status, 403);
});

test('未注入校验器时清单路由不开放（返回 404 而非裸奔）', async () => {
  const result = await postJson(bare.url, '/api/shares/manifest', {
    signed: null,
    requesterId: MAC_DEVICE_ID,
  });
  assert.equal(result.status, 404);
});

test('请求体非法时返回 400 而不是崩溃', async () => {
  const response = await fetch(`${wired.url}/api/shares/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(response.status, 400);
});
