/**
 * 端到端集成测试（多任务版）：起一台「主端 syncService」+ 一台「从端 syncServer」，
 * 用真实的 credential-store 配公钥、真实的 HTTP 打真实的端点。
 *
 * 覆盖核心路径：多任务创建/启停守卫 → 推送文件 → 从端落盘；主端删文件 → 从端进回收区；
 * 从端多余文件 → 全量校验清掉；未授权设备被拒；失败补偿；请求不存在的任务得到明确错误。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
/* global Buffer, setTimeout */

const require = createRequire(import.meta.url);
const { startSyncServer } = require('../electron/sync-server');
const { createSyncService } = require('../electron/sync-service');
const { createCredentialStore } = require('../core/credential-store');
const { createChallenge } = require('../core/light-auth');

const MASTER = 'dev_master0000000000000000000000000';
const SLAVE = 'dev_slave0000000000000000000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tempDir;
let slaveServer;
let masterService;
let masterRoot;
let slaveRoot;
let taskId;
let slaveStore; // 复用（补偿测试重启从端时重建 getTask 依赖）
const slaveTasks = new Map(); // 从端已注册的任务：id -> { name, localRoot, trashRetentionDays }
const syncNotices = [];
const syncInvitations = [];

function makeServer(port = 0) {
  return startSyncServer({
    port,
    deviceId: SLAVE,
    lookupTrustedPublicKey: (id) => {
      try { return JSON.parse(slaveStore.get(String(id || '')) || '{}').publicKey || null; } catch { return null; }
    },
    createChallenge: ({ deviceId: did, requesterId }) => createChallenge({ deviceId: did, requesterId }),
    onEvent: () => {},
    onNotify: (key, event) => syncNotices.push({ key, event }),
    onInvite: (invitation) => syncInvitations.push(invitation),
    getTask: (key) => slaveTasks.get(String(key || '')) || null,
  });
}

async function ensureStarted() {
  const t = masterService.listTasks().find((x) => x.id === taskId);
  if (!t.enabled) {
    await masterService.startTask(taskId);
    await sleep(400); // 等 start 触发的首轮全量跑完，避免与手动 runNow 竞争
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-sync-e2e-'));
  masterRoot = path.join(tempDir, 'master');
  slaveRoot = path.join(tempDir, 'slave');
  fs.mkdirSync(masterRoot, { recursive: true });
  fs.mkdirSync(slaveRoot, { recursive: true });

  const masterKeys = crypto.generateKeyPairSync('ed25519');
  slaveStore = createCredentialStore(path.join(tempDir, 'slave-trusted.json'));
  slaveStore.set(MASTER, JSON.stringify({
    fingerprint: 'sha256:master',
    publicKey: masterKeys.publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  const masterPrivPath = path.join(tempDir, 'master.pem');
  fs.writeFileSync(masterPrivPath, masterKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));

  slaveServer = await makeServer();

  masterService = createSyncService({
    dataDir: tempDir,
    deviceId: MASTER,
    deviceName: 'Master Mac',
    privateKeyPath: masterPrivPath,
    port: 0,
    startServer: async () => ({ close: async () => {}, port: 0 }), // 本测试主端不起 server
    lookupTrustedPublicKey: () => null,
    logEvent: () => {},
    onState: () => {},
  });

  const task = masterService.addTask({
    name: 'e2e 同步',
    role: 'master',
    localRoot: masterRoot,
    peerDeviceId: SLAVE,
    peerAddress: '127.0.0.1',
    peerPort: slaveServer.port,
    chunkSize: 1024,
    debounceMs: 999999, // 禁用 watch 防抖触发，避免与手动 runNow 竞争
    fullScanMs: 999999, // 测试中手动触发全量，不靠定时器
    maxAttempts: 2,
  });
  taskId = task.id;
  // 真实从端按 pairKey 匹配；测试里注册 pairKey 与 taskId 两个键
  slaveTasks.set(task.pairKey, { name: 'e2e', localRoot: slaveRoot, trashRetentionDays: 7 });
  slaveTasks.set(taskId, { name: 'e2e', localRoot: slaveRoot, trashRetentionDays: 7 });
});

after(async () => {
  if (slaveServer) await slaveServer.close();
  if (masterService) await masterService.dispose();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('主端创建任务后可发送签名邀请，从端收到除目录外的预填信息', async () => {
  const result = await masterService.inviteTask(taskId);
  assert.equal(result.ok, true);
  assert.equal(syncInvitations.length, 1);
  assert.equal(syncInvitations[0].taskName, 'e2e 同步');
  assert.equal(syncInvitations[0].peerDeviceId, MASTER);
  assert.equal(syncInvitations[0].peerDeviceName, 'Master Mac');
  assert.match(syncInvitations[0].pairKey, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(syncInvitations[0].peerAddress, '127.0.0.1');
});

test('运行中的任务不可修改配置/删除，停止后可以；未启动不可 runNow', async () => {
  await masterService.startTask(taskId);
  await sleep(400);
  assert.throws(() => masterService.updateTask(taskId, { name: 'x' }), /请先停止/);
  assert.throws(() => masterService.removeTask(taskId), /请先停止/);
  await masterService.stopTask(taskId);
  assert.ok(syncNotices.some((notice) => notice.event === 'stopped'), '停止任务应即时通知对端');
  const updated = masterService.updateTask(taskId, { name: 'e2e 同步' });
  assert.equal(updated.name, 'e2e 同步');
  const stopped = await masterService.runNow(taskId);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, 'TASK_STOPPED');
});

test('主端新增文件 → 从端落盘且内容一致', async () => {
  await ensureStarted();
  fs.writeFileSync(path.join(masterRoot, 'a.txt'), 'hello sync');
  fs.mkdirSync(path.join(masterRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(masterRoot, 'sub/b.txt'), 'nested content');

  const result = await masterService.runNow(taskId);
  assert.equal(result.ok, true);
  assert.equal(result.pushed, 2);

  assert.equal(fs.readFileSync(path.join(slaveRoot, 'a.txt'), 'utf8'), 'hello sync');
  assert.equal(fs.readFileSync(path.join(slaveRoot, 'sub/b.txt'), 'utf8'), 'nested content');
});

test('主端确认从端任务有效后持久化关联状态并拒绝重复邀请', async () => {
  const task = masterService.listTasks().find((item) => item.id === taskId);
  assert.match(task.peerLinkedAt, /^\d{4}-\d{2}-\d{2}T/);
  const repeated = await masterService.inviteTask(taskId);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.reason, 'ALREADY_LINKED');
});

test('主端修改文件 → 从端覆盖更新', async () => {
  await ensureStarted();
  fs.writeFileSync(path.join(masterRoot, 'a.txt'), 'updated content');
  const result = await masterService.runNow(taskId);
  assert.equal(result.pushed, 1);
  assert.equal(fs.readFileSync(path.join(slaveRoot, 'a.txt'), 'utf8'), 'updated content');
});

test('全量校验会修复从端同路径文件被篡改的内容', async () => {
  await ensureStarted();
  const target = path.join(slaveRoot, 'a.txt');
  fs.writeFileSync(target, 'tampered data!!');
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(target, future, future);
  const result = await masterService.runNow(taskId);
  assert.equal(result.ok, true);
  assert.ok(result.pushed >= 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'updated content');
});

test('失败补偿：从端不可达时推送失败，恢复后下轮自动补推', async () => {
  await ensureStarted();
  fs.writeFileSync(path.join(masterRoot, 'retry.txt'), 'needs compensation');
  // 关掉从端 → 推送失败
  await slaveServer.close();
  const failed = await masterService.runNow(taskId);
  assert.equal(failed.ok, false);

  // 重启从端（同一 taskId 路由；优先复用原端口）
  const prevPort = slaveServer.port;
  slaveServer = await makeServer(prevPort).catch(() => makeServer(0));
  const task = masterService.listTasks().find((t) => t.id === taskId);
  if (task.peerPort !== slaveServer.port) {
    masterService.updateTask(taskId, { peerPort: slaveServer.port });
  }

  const retry = await masterService.runNow(taskId);
  assert.equal(retry.ok, true);
  assert.equal(retry.pushed, 1, '失败文件下一轮被补偿推送');
  assert.equal(fs.readFileSync(path.join(slaveRoot, 'retry.txt'), 'utf8'), 'needs compensation');
});

test('主端删除文件 → 从端文件移入回收区而非直接删除', async () => {
  await ensureStarted();
  fs.unlinkSync(path.join(masterRoot, 'a.txt'));
  const result = await masterService.runNow(taskId);
  assert.equal(result.trashed, 1);

  assert.equal(fs.existsSync(path.join(slaveRoot, 'a.txt')), false);
  const trashDir = path.join(slaveRoot, '.innernet-trash');
  assert.equal(fs.existsSync(trashDir), true);
  const batches = fs.readdirSync(trashDir);
  assert.ok(batches.length > 0, '回收区至少有一个批次');
});

test('从端不可达导致回收失败时，恢复后下一轮继续补偿删除', async () => {
  await ensureStarted();
  const masterFile = path.join(masterRoot, 'delete-retry.txt');
  const slaveFile = path.join(slaveRoot, 'delete-retry.txt');
  fs.writeFileSync(masterFile, 'delete me later');
  await masterService.runNow(taskId);
  assert.equal(fs.existsSync(slaveFile), true);

  fs.unlinkSync(masterFile);
  const prevPort = slaveServer.port;
  await slaveServer.close();
  const failed = await masterService.runNow(taskId);
  slaveServer = await makeServer(prevPort).catch(() => makeServer(0));
  assert.equal(slaveServer.port, prevPort, '测试需复用原端口以验证下一轮补偿');
  assert.equal(failed.ok, false);
  assert.equal(fs.existsSync(slaveFile), true);
  const retried = await masterService.runNow(taskId);
  assert.equal(retried.ok, true);
  assert.equal(fs.existsSync(slaveFile), false);
});

test('从端多余文件 → 全量校验时清进回收区', async () => {
  await ensureStarted();
  fs.writeFileSync(path.join(slaveRoot, 'stray.txt'), 'i should not be here');
  const result = await masterService.runNow(taskId);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(slaveRoot, 'stray.txt')), false);
});

test('主端可配置排除项在从端保留或标记失效后回收', async () => {
  await ensureStarted();
  await masterService.stopTask(taskId);
  masterService.updateTask(taskId, { ignore: 'excluded/', cleanupIgnoredOnSlave: false });

  const excludedDir = path.join(slaveRoot, 'excluded');
  const excludedFile = path.join(excludedDir, 'keep.txt');
  fs.mkdirSync(excludedDir, { recursive: true });
  fs.writeFileSync(excludedFile, 'slave copy');
  await masterService.startTask(taskId);
  await sleep(400);
  await masterService.runNow(taskId);
  assert.equal(fs.existsSync(excludedFile), true, '保留策略不得清理从端排除项');

  await masterService.stopTask(taskId);
  masterService.updateTask(taskId, { cleanupIgnoredOnSlave: true });
  await masterService.startTask(taskId);
  await sleep(400);
  await masterService.runNow(taskId);
  assert.equal(fs.existsSync(excludedFile), false, '失效策略应把从端排除项移入回收区');

  await masterService.stopTask(taskId);
  masterService.updateTask(taskId, { ignore: '', cleanupIgnoredOnSlave: false });
  await masterService.startTask(taskId);
  await sleep(400);
});

test('主端请求从端不存在的任务 → 得到明确错误而非静默失败', async () => {
  // 用独立的 localRoot，避免本任务推送失败影响主任务目录的索引状态
  const ghostRoot = path.join(tempDir, 'ghost');
  fs.mkdirSync(ghostRoot, { recursive: true });
  fs.writeFileSync(path.join(ghostRoot, 'never.txt'), 'x');
  const task = masterService.addTask({
    name: '指向不存在任务的同步',
    role: 'master',
    localRoot: ghostRoot,
    peerDeviceId: SLAVE,
    peerAddress: '127.0.0.1',
    peerPort: slaveServer.port,
    chunkSize: 1024,
    maxAttempts: 1,
  });
  await masterService.startTask(task.id);
  await sleep(300);
  const result = await masterService.runNow(task.id);
  assert.equal(result.ok, false);
  assert.match(result.error || '', /不存在|已停止/);
  await masterService.stopTask(task.id);
  masterService.removeTask(task.id);
});

test('从端拒绝未配对设备的请求', async () => {
  const impostorKeys = crypto.generateKeyPairSync('ed25519');
  const impostorPrivPath = path.join(tempDir, 'impostor.pem');
  fs.writeFileSync(impostorPrivPath, impostorKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));

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
  const task = impostor.addTask({
    name: '冒充',
    role: 'master',
    localRoot: masterRoot,
    peerDeviceId: 'dev_impostor000000000000000000000000',
    peerAddress: '127.0.0.1',
    peerPort: slaveServer.port,
    chunkSize: 1024,
    maxAttempts: 1,
  });
  await impostor.startTask(task.id);
  await sleep(300);

  const result = await impostor.runNow(task.id);
  assert.equal(result.ok, false);
  assert.match(result.error || '', /未获信任|挑战/);
  await impostor.dispose();
});

test('分块传输正确处理大文件（跨多个 chunk）', async () => {
  await ensureStarted();
  const content = Buffer.alloc(2560, 0x42).toString('utf8');
  fs.writeFileSync(path.join(masterRoot, 'big.bin'), content);

  const result = await masterService.runNow(taskId);
  assert.equal(result.pushed, 1);

  const synced = fs.readFileSync(path.join(slaveRoot, 'big.bin'), 'utf8');
  assert.equal(synced, content);
  assert.equal(synced.length, 2560);
});

test('多任务并存：同一主端可挂多条任务，各自目录与索引独立', async () => {
  await ensureStarted();
  const secondRoot = path.join(tempDir, 'master2');
  fs.mkdirSync(secondRoot, { recursive: true });
  fs.writeFileSync(path.join(secondRoot, 'only2.txt'), 'second root');

  const task2 = masterService.addTask({
    name: '第二条',
    role: 'master',
    localRoot: secondRoot,
    peerDeviceId: SLAVE,
    peerAddress: '127.0.0.1',
    peerPort: slaveServer.port,
    chunkSize: 1024,
    maxAttempts: 2,
  });
  // 真实场景：两端各自配置对应任务——从端按 pairKey 注册 task2
  slaveTasks.set(task2.pairKey, { name: '第二条(从端)', localRoot: slaveRoot, trashRetentionDays: 7 });
  await masterService.startTask(task2.id);
  await sleep(300);

  const result = await masterService.runNow(task2.id);
  assert.equal(result.ok, true);
  // 手动轮可能撞上启动首轮而 queued；轮询等待从端实际落盘
  const dest = path.join(slaveRoot, 'only2.txt');
  for (let i = 0; i < 50 && !fs.existsSync(dest); i += 1) await sleep(100);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'second root');

  assert.ok(masterService.listTasks().length >= 2);
  await masterService.stopTask(task2.id);
  masterService.removeTask(task2.id);
  slaveTasks.delete(task2.pairKey);
});
