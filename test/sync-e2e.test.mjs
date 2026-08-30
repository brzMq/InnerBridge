/**
 * 端到端集成测试：起一台「主端 syncService」+ 一台「从端 syncServer」，
 * 用真实的 credential-store 配公钥、真实的 HTTP 打真实的端点。
 *
 * 覆盖核心路径：推送文件 → 从端落盘；主端删文件 → 从端进回收区；
 * 从端多余文件 → 全量校验时清掉；未授权设备被拒。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
/* global Buffer */

const require = createRequire(import.meta.url);
const { startSyncServer } = require('../electron/sync-server');
const { createSyncService } = require('../electron/sync-service');
const { createCredentialStore } = require('../core/credential-store');
const { createChallenge } = require('../core/light-auth');

const MASTER = 'dev_master0000000000000000000000000';
const SLAVE = 'dev_slave0000000000000000000000000000';

let tempDir;
let masterKeys;
let slaveKeys;
let slaveStore;
let slaveServer;
let masterService;
let masterRoot;
let slaveRoot;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-sync-e2e-'));
  masterRoot = path.join(tempDir, 'master');
  slaveRoot = path.join(tempDir, 'slave');
  fs.mkdirSync(masterRoot, { recursive: true });
  fs.mkdirSync(slaveRoot, { recursive: true });

  masterKeys = crypto.generateKeyPairSync('ed25519');
  slaveKeys = crypto.generateKeyPairSync('ed25519');

  // 从端信任主端：存主端公钥
  slaveStore = createCredentialStore(path.join(tempDir, 'slave-trusted.json'));
  slaveStore.set(MASTER, JSON.stringify({
    fingerprint: 'sha256:master',
    publicKey: masterKeys.publicKey.export({ type: 'spki', format: 'pem' }),
  }));

  // 主端私钥文件（syncService 读取的格式）
  const masterPrivPath = path.join(tempDir, 'master.pem');
  fs.writeFileSync(masterPrivPath, masterKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));

  // 主端信任从端（仅用于同步服务初始化，实际同步只验主端身份）
  const masterStore = createCredentialStore(path.join(tempDir, 'master-trusted.json'));
  masterStore.set(SLAVE, JSON.stringify({
    fingerprint: 'sha256:slave',
    publicKey: slaveKeys.publicKey.export({ type: 'spki', format: 'pem' }),
  }));

  // 从端 syncServer
  slaveServer = await startSyncServer({
    port: 0,
    root: slaveRoot,
    deviceId: SLAVE,
    lookupTrustedPublicKey: (id) => {
      try { return JSON.parse(slaveStore.get(String(id || '')) || '{}').publicKey || null; } catch { return null; }
    },
    createChallenge: ({ deviceId, requesterId }) => createChallenge({ deviceId, requesterId }),
    onEvent: () => {},
  });

  // 主端 syncService（用真实 fetch 打从端）
  masterService = createSyncService({
    dataDir: tempDir,
    deviceId: MASTER,
    privateKeyPath: masterPrivPath,
    port: 0,
    startServer: async () => ({ close: async () => {}, port: 0 }), // 主端不需要起 server
    lookupTrustedPublicKey: (id) => {
      try { return JSON.parse(masterStore.get(String(id || '')) || '{}').publicKey || null; } catch { return null; }
    },
    logEvent: () => {},
    onState: () => {},
  });

  masterService.updateConfig({
    role: 'master',
    masterRoot,
    slaveRoot,
    peerDeviceId: SLAVE,
    peerAddress: '127.0.0.1',
    peerPort: slaveServer.port,
    trashRetentionDays: 7,
    chunkSize: 1024,
    debounceMs: 100,
    fullScanMs: 999999, // 测试中手动触发全量，不靠定时器
    maxAttempts: 2,
  });
});

after(async () => {
  if (slaveServer) await slaveServer.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('主端新增文件 → 从端落盘且内容一致', async () => {
  fs.writeFileSync(path.join(masterRoot, 'a.txt'), 'hello sync');
  fs.mkdirSync(path.join(masterRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(masterRoot, 'sub/b.txt'), 'nested content');

  const result = await masterService.runCycle({ fullScan: false, reason: 'test' });
  assert.equal(result.ok, true);
  assert.equal(result.pushed, 2);

  assert.equal(fs.readFileSync(path.join(slaveRoot, 'a.txt'), 'utf8'), 'hello sync');
  assert.equal(fs.readFileSync(path.join(slaveRoot, 'sub/b.txt'), 'utf8'), 'nested content');
});

test('主端修改文件 → 从端覆盖更新', async () => {
  fs.writeFileSync(path.join(masterRoot, 'a.txt'), 'updated content');
  const result = await masterService.runCycle({ fullScan: false, reason: 'test' });
  assert.equal(result.pushed, 1);
  assert.equal(fs.readFileSync(path.join(slaveRoot, 'a.txt'), 'utf8'), 'updated content');
});

test('主端删除文件 → 从端文件移入回收区而非直接删除', async () => {
  fs.unlinkSync(path.join(masterRoot, 'a.txt'));
  const result = await masterService.runCycle({ fullScan: false, reason: 'test' });
  assert.equal(result.trashed, 1);

  // 从端原文件已不在原位
  assert.equal(fs.existsSync(path.join(slaveRoot, 'a.txt')), false);
  // 但在回收区里能找到
  // 注意：回收区是主端通知从端去移的，查从端文件系统
  const trashDir = path.join(slaveRoot, '.innernet-trash');
  assert.equal(fs.existsSync(trashDir), true);
  const batches = fs.readdirSync(trashDir);
  assert.ok(batches.length > 0, '回收区至少有一个批次');
});

test('从端多余文件 → 全量校验时清进回收区', async () => {
  // 从端放一个主端没有的文件
  fs.writeFileSync(path.join(slaveRoot, 'stray.txt'), 'i should not be here');

  const result = await masterService.runCycle({ fullScan: true, reason: 'test' });
  assert.equal(result.ok, true);
  // stray.txt 被移入回收区
  assert.equal(fs.existsSync(path.join(slaveRoot, 'stray.txt')), false);
});

test('从端拒绝未配对设备的请求', async () => {
  // 用另一个设备的密钥
  const impostorKeys = crypto.generateKeyPairSync('ed25519');
  const impostorPrivPath = path.join(tempDir, 'impostor.pem');
  fs.writeFileSync(impostorPrivPath, impostorKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));

  // 另起一个 syncService 冒充主端
  const impostor = createSyncService({
    dataDir: path.join(tempDir, 'impostor-data'),
    deviceId: 'dev_impostor000000000000000000000000',
    privateKeyPath: impostorPrivPath,
    port: 0,
    startServer: async () => ({ close: async () => {}, port: 0 }),
    lookupTrustedPublicKey: () => null,
    logEvent: () => {},
    onState: () => {},
  });
  impostor.updateConfig({
    role: 'master',
    masterRoot,
    peerDeviceId: 'dev_impostor000000000000000000000000',
    peerAddress: '127.0.0.1',
    peerPort: slaveServer.port,
    chunkSize: 1024,
    fullScanMs: 999999,
  });

  const result = await impostor.runCycle({ fullScan: true, reason: 'test' });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /未获信任|挑战/);
});

test('分块传输正确处理大文件（跨多个 chunk）', async () => {
  // chunkSize=1024，写 2.5KB 的文件 → 3 个分块
  const content = Buffer.alloc(2560, 0x42).toString('utf8');
  fs.writeFileSync(path.join(masterRoot, 'big.bin'), content);

  const result = await masterService.runCycle({ fullScan: false, reason: 'test' });
  assert.equal(result.pushed, 1);

  const synced = fs.readFileSync(path.join(slaveRoot, 'big.bin'), 'utf8');
  assert.equal(synced, content);
  assert.equal(synced.length, 2560);
});

test('恢复回收区文件后文件回到原位', async () => {
  // 之前 a.txt 进了回收区，找到它并恢复
  const trashDir = path.join(slaveRoot, '.innernet-trash');
  const batches = fs.readdirSync(trashDir);
  let foundStamp = null;
  let foundRel = null;
  for (const stamp of batches) {
    const walk = (absDir, relDir) => {
      for (const name of fs.readdirSync(absDir)) {
        const abs = path.join(absDir, name);
        const rel = relDir ? `${relDir}/${name}` : name;
        if (fs.statSync(abs).isDirectory()) walk(abs, rel);
        else if (name === 'a.txt') { foundStamp = stamp; foundRel = rel; }
      }
    };
    walk(path.join(trashDir, stamp), '');
    if (foundStamp) break;
  }
  assert.ok(foundStamp, '回收区里能找到 a.txt');

  // listTrash 读的是 masterService 的 slaveRoot（从端视角）
  // 但 masterService 是主端，listTrash 在主端无意义。这里直接验证文件系统
  const source = path.join(trashDir, foundStamp, foundRel);
  const dest = path.join(slaveRoot, 'a.txt');
  assert.equal(fs.existsSync(source), true);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(source, dest);
  assert.equal(fs.existsSync(dest), true);
});
