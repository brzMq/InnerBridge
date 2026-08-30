/**
 * 文件夹同步的编排层：主从角色、目录监听、同步周期、失败重试、状态上报。
 *
 * 单向主从语义：主端是唯一事实来源。主端变更推给从端，主端删除的文件在从端
 * 移入回收区（可恢复），从端多出来的文件也在全量校验轮被清进回收区。
 * 不做双向合并，也不做冲突检测 —— 主端永远赢，这是刻意的设计取舍。
 */
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../core/transfer');
const { signChallenge } = require('../core/light-auth');
const {
  DEFAULT_CHUNK_SIZE, DEFAULT_TRASH_RETENTION_DAYS, INCOMING_DIR, TRASH_DIR,
  backoffMs, chunkPlan, computePlan, extrasOnSlave, normalizeRelPath,
  parseTrashStamp, purgeStamps, scanTree, toIndex,
} = require('../core/sync-engine');

const DEFAULT_CONFIG = {
  role: 'off', // off | master | slave
  masterRoot: '',
  slaveRoot: '',
  peerDeviceId: '',
  peerAddress: '',
  peerPort: 7892,
  trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
  chunkSize: DEFAULT_CHUNK_SIZE,
  debounceMs: 800,
  fullScanMs: 300000,
  maxAttempts: 3,
};

const HISTORY_LIMIT = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function readChunk(abs, index, chunkSize, size) {
  const start = index * chunkSize;
  const length = Math.min(chunkSize, size - start);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(abs, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

function createSyncService({
  dataDir,
  deviceId,
  privateKeyPath,
  port: syncPort = 7892,
  startServer,
  lookupTrustedPublicKey,
  logEvent = () => {},
  onState = () => {},
} = {}) {
  const configFile = path.join(dataDir, 'sync.json');
  const indexFile = path.join(dataDir, 'sync-index.json');

  let config = { ...DEFAULT_CONFIG, ...loadJson(configFile, {}) };
  let index = loadJson(indexFile, {});
  let history = [];
  let status = { running: false, lastSyncAt: null, lastError: null, currentFile: '', fileCount: 0, pending: 0 };
  let watcher = null;
  let debounceTimer = null;
  let pollTimer = null;
  let server = null;
  let cycleQueued = false;
  let cycleRunning = false;
  let challengeCache = null;

  const persistConfig = () => saveJson(configFile, config);
  const persistIndex = () => saveJson(indexFile, index);

  function pushHistory(entry) {
    history.unshift({ ...entry, at: new Date().toISOString() });
    if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  }

  function emitState(extra = {}) {
    status = { ...status, ...extra };
    try {
      onState({
        config: { ...config },
        status: { ...status },
        history: history.slice(0, 50),
      });
    } catch {
      /* 推送失败不影响同步 */
    }
  }

  // ---------- 主端：与从端通信 ----------

  function baseUrl() {
    const port = Number(config.peerPort) || 7892;
    return `http://${config.peerAddress}:${port}`;
  }

  async function post(url, payload) {
    const response = await globalThis.fetch(`${baseUrl()}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  /** 取挑战并签名；快过期时自动续签，避免长周期同步中途失效 */
  async function authPayload() {
    if (challengeCache && challengeCache.expiresAt > Date.now() + 30000) {
      return { signed: challengeCache.signed, requesterId: deviceId };
    }
    const challenge = await post('/api/sync/challenge', { requesterId: deviceId });
    if (!challenge?.challengeId) throw new Error('从端未下发认证挑战');
    const signed = signChallenge(challenge, fs.readFileSync(privateKeyPath, 'utf8'));
    challengeCache = { signed, expiresAt: challenge.expiresAt };
    return { signed, requesterId: deviceId };
  }

  async function withRetry(operation, label) {
    const attempts = Math.max(1, Number(config.maxAttempts) || 1);
    let lastError;
    for (let i = 1; i <= attempts; i += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (i >= attempts) break;
        const wait = backoffMs(i);
        logEvent('warn', 'sync', `${label} 第 ${i} 次失败，${wait}ms 后重试：${error.message}`);
        await sleep(wait);
      }
    }
    throw lastError;
  }

  async function pushOne(root, rel) {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    const sha256 = await hashFile(abs);
    const plan = chunkPlan(stat.size, Number(config.chunkSize) || DEFAULT_CHUNK_SIZE);
    const auth = await authPayload();

    const begun = await post('/api/sync/begin', {
      ...auth, path: rel, size: plan.size, sha256, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount,
    });
    const transferId = begun.transferId;
    for (let i = 0; i < plan.chunkCount; i += 1) {
      await post('/api/sync/chunk', {
        ...auth, transferId, index: i, data: readChunk(abs, i, plan.chunkSize, plan.size).toString('base64'),
      });
    }
    await post('/api/sync/commit', { ...auth, transferId });
    return { rel, size: plan.size };
  }

  // ---------- 主端：一轮同步 ----------

  async function runCycle({ fullScan = false, reason = 'manual' } = {}) {
    if (config.role !== 'master') return { ok: false, reason: 'NOT_MASTER' };
    if (cycleRunning) { cycleQueued = true; return { ok: true, queued: true }; }
    cycleRunning = true;
    emitState({ running: true, currentFile: '' });

    const summary = { pushed: 0, trashed: 0, failed: 0, skipped: 0, fullScan, reason };
    try {
      if (!config.masterRoot) throw new Error('主端目录未配置');
      if (!config.peerAddress || !config.peerDeviceId) throw new Error('未指定从端设备');
      // 先把挑战取到手，后续 list/trash/purge 才能直接复用（周期内会自动续签）
      await authPayload();

      const current = scanTree(config.masterRoot);
      const plan = computePlan(current, index);
      const toTrash = [...plan.toTrash];

      // 全量校验轮：拿从端清单比对，把从端多出来的文件也清掉
      if (fullScan) {
        const remote = await withRetry(() => post('/api/sync/list', { ...challengePayloadSync() }), '拉取从端清单');
        const extras = extrasOnSlave(current, (remote.files || []).map((f) => f.path));
        for (const rel of extras) {
          if (!toTrash.includes(rel)) toTrash.push(rel);
        }
        summary.extras = extras.length;
      }

      for (const rel of plan.toPush) {
        emitState({ currentFile: rel, pending: plan.toPush.length - summary.pushed });
        try {
          await withRetry(() => pushOne(config.masterRoot, rel), `推送 ${rel}`);
          summary.pushed += 1;
          pushHistory({ kind: 'push', path: rel, ok: true });
        } catch (error) {
          // 文件在读取瞬间被删/被占：记一笔，下轮再试，不让整轮崩掉
          if (!fs.existsSync(path.join(config.masterRoot, rel))) {
            summary.skipped += 1;
            pushHistory({ kind: 'push', path: rel, ok: false, message: '文件已不存在，跳过' });
            continue;
          }
          summary.failed += 1;
          pushHistory({ kind: 'push', path: rel, ok: false, message: error.message });
          logEvent('error', 'sync', `推送 ${rel} 失败：${error.message}`);
        }
      }

      if (toTrash.length) {
        try {
          const result = await withRetry(() => post('/api/sync/trash', { ...challengePayloadSync(), paths: toTrash }), '清理从端失效文件');
          summary.trashed = (result.moved || []).length;
          for (const rel of result.moved || []) pushHistory({ kind: 'trash', path: rel, ok: true });
        } catch (error) {
          summary.failed += toTrash.length;
          logEvent('error', 'sync', `清理从端失效文件失败：${error.message}`);
          pushHistory({ kind: 'trash', path: `${toTrash.length} 个文件`, ok: false, message: error.message });
        }
      }

      try {
        await post('/api/sync/purge', { ...challengePayloadSync(), retentionDays: Number(config.trashRetentionDays) });
      } catch (error) {
        logEvent('warn', 'sync', `清理从端过期回收区失败（不影响同步）：${error.message}`);
      }

      // 索引只记录本轮成功处理过的状态；失败的下一轮会重新比对出来
      index = toIndex(current);
      persistIndex();
      status = { ...status, lastSyncAt: new Date().toISOString(), lastError: null, fileCount: current.size };
      pushHistory({ kind: 'cycle', ok: true, message: `推送 ${summary.pushed}，回收 ${summary.trashed}，失败 ${summary.failed}` });
      logEvent('info', 'sync', `同步完成（${reason}）：推送 ${summary.pushed}，回收 ${summary.trashed}，失败 ${summary.failed}`);
      return { ok: true, ...summary };
    } catch (error) {
      status = { ...status, lastError: error.message };
      pushHistory({ kind: 'cycle', ok: false, message: error.message });
      logEvent('error', 'sync', `同步失败（${reason}）：${error.message}`);
      return { ok: false, error: error.message, ...summary };
    } finally {
      cycleRunning = false;
      emitState({ running: false, currentFile: '', pending: 0 });
      if (cycleQueued) {
        cycleQueued = false;
        setTimeout(() => runCycle({ fullScan: true, reason: 'queued' }), 200);
      }
    }
  }

  // 供 runCycle 内部使用：同步版的 auth 取用（cycle 内已保证 challengeCache 有效）
  function challengePayloadSync() {
    if (challengeCache) return { signed: challengeCache.signed, requesterId: deviceId };
    return { signed: null, requesterId: deviceId };
  }

  // ---------- 主端：监听与轮询 ----------

  function scheduleCycle(fullScan) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runCycle({ fullScan, reason: fullScan ? 'full-scan' : 'watch' }).catch(() => {});
    }, Math.max(100, Number(config.debounceMs) || 800));
  }

  function startWatcher() {
    stopWatcher();
    if (!config.masterRoot) return;
    try {
      watcher = fs.watch(config.masterRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = normalizeRelPath(filename);
        // 回收区/暂存区的写入是自己造成的，不能反过来触发同步
        if (!rel || rel.startsWith(TRASH_DIR) || rel.startsWith(INCOMING_DIR)) return;
        scheduleCycle(false);
      });
      logEvent('info', 'sync', `已监听主端目录：${config.masterRoot}`);
    } catch (error) {
      logEvent('error', 'sync', `监听主端目录失败：${error.message}（将依赖定时校验）`);
    }
  }

  function stopWatcher() {
    if (watcher) { try { watcher.close(); } catch { /* 已关闭 */ } watcher = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  function startPolling() {
    stopPolling();
    const interval = Math.max(30000, Number(config.fullScanMs) || 300000);
    pollTimer = setInterval(() => runCycle({ fullScan: true, reason: 'poll' }).catch(() => {}), interval);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---------- 从端：本地回收区维护 ----------

  function trashRoot() {
    return config.slaveRoot ? path.join(config.slaveRoot, TRASH_DIR) : '';
  }

  function listTrash() {
    const root = trashRoot();
    if (!root || !fs.existsSync(root)) return [];
    const out = [];
    for (const stamp of fs.readdirSync(root).sort().reverse()) {
      const ts = parseTrashStamp(stamp);
      if (ts === null) continue;
      const files = [];
      const walk = (absDir, relDir) => {
        for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          const abs = path.join(absDir, entry.name);
          if (entry.isDirectory()) walk(abs, rel);
          else if (entry.isFile()) files.push(rel);
        }
      };
      try {
        walk(path.join(root, stamp), '');
      } catch {
        continue;
      }
      out.push({ stamp, at: new Date(ts).toISOString(), count: files.length, files });
    }
    return out;
  }

  function restoreFromTrash(stamp, rel) {
    const root = trashRoot();
    if (!root) throw new Error('从端目录未配置');
    const source = path.join(root, String(stamp), normalizeRelPath(rel));
    const dest = path.join(config.slaveRoot, normalizeRelPath(rel));
    if (!fs.existsSync(source)) throw new Error('回收区中找不到该文件');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(source, dest);
    logEvent('info', 'sync', `已从回收区恢复 ${rel}`);
    return { ok: true, path: normalizeRelPath(rel) };
  }

  function purgeTrash({ all = false, retentionDays } = {}) {
    const root = trashRoot();
    if (!root || !fs.existsSync(root)) return { purged: [] };
    const entries = fs.readdirSync(root);
    const targets = all
      ? entries.filter((name) => parseTrashStamp(name) !== null)
      : purgeStamps(entries, retentionDays ?? Number(config.trashRetentionDays));
    const purged = [];
    for (const stamp of targets) {
      try {
        fs.rmSync(path.join(root, stamp), { recursive: true, force: true });
        purged.push(stamp);
      } catch {
        /* 个别失败不阻断 */
      }
    }
    if (purged.length) logEvent('info', 'sync', `已清理 ${purged.length} 个回收批次`);
    return { purged };
  }

  // ---------- 生命周期 ----------

  async function stopServer() {
    if (server) {
      try { await server.close(); } catch { /* 已关闭 */ }
      server = null;
    }
  }

  async function apply({ start: shouldStart = true } = {}) {
    stopWatcher();
    stopPolling();
    await stopServer();
    challengeCache = null;

    if (!shouldStart || config.role === 'off') {
      emitState({ running: false });
      return { ok: true, role: config.role, active: false };
    }

    if (config.role === 'slave') {
      if (!config.slaveRoot) throw new Error('从端目录未配置');
      fs.mkdirSync(config.slaveRoot, { recursive: true });
      server = await startServer({
        port: Number(config.peerPort) || syncPort,
        root: config.slaveRoot,
        deviceId,
        lookupTrustedPublicKey,
        onEvent: ({ level, message }) => logEvent(level, 'sync', message),
      });
      logEvent('info', 'sync', `从端同步服务已启动：${server.port}`);
      emitState({ running: false });
      return { ok: true, role: 'slave', active: true, port: server.port };
    }

    if (config.role === 'master') {
      startWatcher();
      startPolling();
      emitState({ running: false });
      runCycle({ fullScan: true, reason: 'start' }).catch(() => {});
      return { ok: true, role: 'master', active: true };
    }

    return { ok: false, reason: 'UNKNOWN_ROLE' };
  }

  function updateConfig(patch = {}) {
    const next = { ...config, ...patch };
    for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
      if (next[key] === undefined) next[key] = fallback;
    }
    config = next;
    persistConfig();
    emitState();
    return { ...config };
  }

  function resetIndex() {
    index = {};
    persistIndex();
    logEvent('info', 'sync', '已清空同步索引，下次同步将全量比对');
    return { ok: true };
  }

  return {
    getConfig: () => ({ ...config }),
    updateConfig,
    getState: () => ({ config: { ...config }, status: { ...status }, history: history.slice(0, 50) }),
    apply,
    runCycle,
    resetIndex,
    listTrash,
    restoreFromTrash,
    purgeTrash,
    port: () => server?.port || null,
    dispose: async () => { stopWatcher(); stopPolling(); await stopServer(); },
  };
}

module.exports = { createSyncService, DEFAULT_CONFIG, readChunk };
