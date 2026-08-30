import test from 'node:test'; import assert from 'node:assert/strict'; import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module'; import { TextEncoder } from 'node:util';
const require = createRequire(import.meta.url); const { createManifest, createTransferState, signTransferChallenge, verifyTransferChallenge } = require('../core/transfer'); const { startTransferServer } = require('../electron/transfer-server'); const { startPairingServer } = require('../electron/security/pairing-service');
test('原生传输端点要求授权并在收齐后校验落盘', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-transfer-')); const receive = path.join(dir, 'receive'); const m = createManifest({ senderId: 'a', receiverId: 'b', name: 'x.bin', size: 4, sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', chunkSize: 4 }); const state = createTransferState(m); state.state = 'accepted'; state.targetDir = receive; const sessions = new Map([[m.transferId, state]]); const s = await startTransferServer({ port: 0, root: dir, sessions, authorize: (manifest, token) => token === 'ok' && manifest.receiverId === 'b' }); try { const denied = await fetch(`http://127.0.0.1:${s.port}/transfer/${m.transferId}/chunk`, { method: 'POST', headers: { 'x-chunk-index': '0', Authorization: 'Bearer bad' }, body: 'test' }); assert.equal(denied.status, 403); const ok = await fetch(`http://127.0.0.1:${s.port}/transfer/${m.transferId}/chunk`, { method: 'POST', headers: { 'x-chunk-index': '0', Authorization: 'Bearer ok' }, body: 'test' }); assert.equal(ok.status, 200); assert.equal(state.state, 'completed'); assert.equal(fs.readFileSync(path.join(receive, 'x.bin'), 'utf8'), 'test'); } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); } });

test('传输服务支持乱序分块并拒绝危险 transferId', async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-transfer-order-')); const m = createManifest({ senderId: 'a', receiverId: 'b', name: 'x.bin', size: 8, sha256: 'a'.repeat(64), chunkSize: 4 }); const state = createTransferState(m); state.state = 'accepted'; const sessions = new Map([[m.transferId, state]]); const s = await startTransferServer({ port: 0, root: dir, host: '127.0.0.1', sessions, authorize: () => true }); try { const second = await fetch(`http://127.0.0.1:${s.port}/transfer/${m.transferId}/chunk`, { method: 'POST', headers: { 'x-chunk-index': '1', Authorization: 'Bearer ok' }, body: '5678' }); assert.equal(second.status, 200); const bad = await fetch(`http://127.0.0.1:${s.port}/transfer/../chunk/chunk`, { method: 'POST', headers: { 'x-chunk-index': '0' }, body: 'test' }); assert.equal(bad.status, 404); } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); } });

test('固定传输端口被占用时自动回退到后续端口', async () => { const net = await import('node:net'); const occupied = net.createServer().listen(0, '127.0.0.1'); await new Promise((resolve) => occupied.once('listening', resolve)); const port = occupied.address().port; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-transfer-fallback-')); const service = await startTransferServer({ port, host: '127.0.0.1', root: dir }); try { assert.equal(service.port, port + 1); } finally { await service.close(); await new Promise((resolve) => occupied.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); } });

test('可信发送方签署接收端挑战后，提议等待本机接受并完整落盘', async () => {
  const senderId = 'dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const receiverId = 'dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const keys = crypto.generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-transfer-flow-'));
  const receive = path.join(dir, 'receive');
  const pairing = await startPairingServer({ port: 0, deviceId: receiverId, lookupTrustedPublicKey: (id) => id === senderId ? keys.publicKey : null });
  let transfer;
  try {
    transfer = await startTransferServer({
      port: 0,
      host: '127.0.0.1',
      root: dir,
      verifyOfferChallenge: (signed, manifest) => verifyTransferChallenge(signed, keys.publicKey, { senderId, receiverId, transferId: manifest.transferId }),
      authorizeOffer: () => true,
      authorize: (manifest, token) => transfer.sessions.get(manifest.transferId)?.offerToken === token,
    });
    const manifest = createManifest({ senderId, receiverId, name: 'flow.txt', size: 4, sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', chunkSize: 64 * 1024 });
    const challengeResponse = await fetch(`http://127.0.0.1:${pairing.port}/api/pair/transfer-challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId, transferId: manifest.transferId }) });
    const challenge = await challengeResponse.json();
    assert.equal(challengeResponse.status, 200);
    const token = 'flow-token';
    const offer = await fetch(`http://127.0.0.1:${transfer.port}/api/transfer/offer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ manifest, signedChallenge: signTransferChallenge(challenge.challenge, keys.privateKey) }) });
    assert.equal(offer.status, 200);
    assert.equal(transfer.sessions.get(manifest.transferId).state, 'offered');
    assert.equal(transfer.decide(manifest.transferId, true, receive, token).state, 'accepted');
    const chunk = await fetch(`http://127.0.0.1:${transfer.port}/transfer/${manifest.transferId}/chunk`, { method: 'POST', headers: { 'x-chunk-index': '0', Authorization: `Bearer ${token}` }, body: 'test' });
    assert.equal(chunk.status, 200);
    assert.equal(fs.readFileSync(path.join(receive, 'flow.txt'), 'utf8'), 'test');
  } finally {
    if (transfer) await transfer.close();
    await new Promise((resolve) => pairing.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件夹传输完成校验后可交给接收端还原目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-transfer-folder-'));
  const receive = path.join(dir, 'receive');
  const content = new TextEncoder().encode('folder-bundle');
  const manifest = createManifest({ senderId: 'a', receiverId: 'b', name: 'photos', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), chunkSize: 64 * 1024 });
  manifest.kind = 'folder';
  manifest.folderMode = 'raw';
  const state = createTransferState(manifest);
  state.state = 'accepted';
  state.targetDir = receive;
  const sessions = new Map([[manifest.transferId, state]]);
  let finalized = false;
  const server = await startTransferServer({
    port: 0,
    host: '127.0.0.1',
    root: dir,
    sessions,
    authorize: () => true,
    finalizeReceived: ({ tmp, state: current }) => {
      finalized = current.manifest.folderMode === 'raw';
      const target = path.join(current.targetDir, current.manifest.name);
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(tmp, path.join(target, 'bundle.tar'));
      return target;
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/transfer/${manifest.transferId}/chunk`, { method: 'POST', headers: { 'x-chunk-index': '0' }, body: content });
    assert.equal(response.status, 200);
    assert.equal(finalized, true);
    assert.equal(state.targetFile, path.join(receive, 'photos'));
    assert.equal(fs.readFileSync(path.join(receive, 'photos', 'bundle.tar'), 'utf8'), 'folder-bundle');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
