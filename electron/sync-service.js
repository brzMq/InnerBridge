/**
 * 文件同步的编排层（多任务版）：任务列表、主从角色、目录监听、同步周期、失败补偿、状态上报。
 *
 * 语义：
 * - 一次配置 = 一条同步任务（同步信息）。启动/停止/立即同步/清空索引/忽略规则都是对某条任务的操作。
 * - 运行中的任务不可修改配置（updateTask 拒绝），必须先停止。
 * - 支持多条任务并存：多个主端任务各自监听各自目录；多个从端任务共享一个监听端口（按 taskId 路由）。
 * - 单向主从：主端是唯一事实来源。主端变更推给从端，主端删除的文件在从端移入回收区（可恢复），
 *   从端多出来的文件也在全量校验轮被清进回收区。不做双向合并 —— 主端永远赢，这是刻意的设计取舍。
 * - 停止联动：主端停止任务时主动通知从端；从端停止后主端下一次连接会收到 409「对端已停止」。
 * - 失败补偿：推送失败（重试耗尽）的文件在索引中保留旧快照，下一轮 diff 自动重推。
 */
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../core/transfer');
const { createChallenge, signChallenge } = require('../core/light-auth');
const {
  DEFAULT_CHUNK_SIZE, DEFAULT_TRASH_RETENTION_DAYS, INCOMING_DIR, TRASH_DIR,
  backoffMs, buildIgnoreMatcher, carryFailures, computePlan, extrasOnSlave, isInternalPath, normalizeRelPath,
  parseTrashStamp, purgeStamps, scanTree, toIndex,
} = require('../core/sync-engine');

const HISTORY_LIMIT = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_TASK = {
  name: '',
  role: 'master', // master | slave
  localRoot: '',
  pairKey: '', // 跨端配对码：两端靠它关联同一条同步（主端自动生成，从端填主端显示的码）
  peerDeviceId: '',
  peerAddress: '',
  peerPort: 7892,
  trashRetentionDays: DEFAULT_TRASH_RETENTION_DAYS,
  chunkSize: DEFAULT_CHUNK_SIZE,
  debounceMs: 800,
  fullScanMs: 300000,
  maxAttempts: 3,
  ignore: '', // 换行分隔的 gitignore 风格忽略规则
  cleanupIgnoredOnSlave: false, // false=从端保留排除项；true=视为失效并移入从端回收区
  peerLinkedAt: null, // 主端成功访问从端任务后写入；已关联时不再重复发送邀请
  enabled: false,
};

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

function normalizeTask(raw) {
  const task = { ...DEFAULT_TASK, ...raw };
  task.role = task.role === 'slave' ? 'slave' : 'master';
  task.enabled = Boolean(task.enabled);
  task.cleanupIgnoredOnSlave = Boolean(task.cleanupIgnoredOnSlave);
  return task;
}

function createSyncService({
  dataDir,
  deviceId,
  deviceName = '',
  privateKeyPath,
  port: syncPort = 7892,
  startServer,
  lookupTrustedPublicKey,
  logEvent = () => {},
  onState = () => {},
  onAccess = () => {},
} = {}) {
  const tasksFile = path.join(dataDir, 'sync-tasks.json');
  const legacyConfigFile = path.join(dataDir, 'sync.json'); // 旧版单任务配置，用于一次性迁移
  const indexDir = path.join(dataDir, 'sync-index');
  const indexFile = (taskId) => path.join(indexDir, `${taskId}.json`);

  // ---------- 任务存储（含旧版单任务迁移） ----------

  function loadTasks() {
    if (fs.existsSync(tasksFile)) {
      const data = loadJson(tasksFile, { tasks: [] });
      return (data.tasks || []).map(normalizeTask);
    }
    // 一次性迁移：旧版 sync.json 的单任务配置 → 一条任务
    const legacy = loadJson(legacyConfigFile, null);
    if (legacy && (legacy.role === 'master' || legacy.role === 'slave')) {
      const task = normalizeTask({
        ...legacy,
        id: newTaskId(),
        name: '迁移的同步任务',
        localRoot: legacy.role === 'master' ? legacy.masterRoot : legacy.slaveRoot,
        enabled: true,
      });
      saveJson(tasksFile, { tasks: [task] });
      logEvent('info', 'sync', '已将旧版单任务同步配置迁移为任务列表');
      return [task];
    }
    return [];
  }

  function newTaskId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 6 位跨端配对码（去掉易混淆字符） */
  function newPairKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  let tasks = loadTasks();
  const persistTasks = () => saveJson(tasksFile, { tasks });

  // ---------- 运行时（每条主端任务独立） ----------

  const runtimes = new Map(); // taskId -> { watcher, debounceTimer, pollTimer, cycleRunning, cycleQueued, challengeCache, index, status, history }
  let slaveServer = null; // 所有从端任务共享一个监听端口

  function freshStatus() {
    return { started: false, running: false, lastSyncAt: null, lastError: null, currentFile: '', fileCount: 0, pending: 0, pendingRetry: 0, peerStopped: false };
  }

  function runtimeFor(taskId) {
    let rt = runtimes.get(taskId);
    if (!rt) {
      rt = { watcher: null, debounceTimer: null, pollTimer: null, cycleRunning: false, cycleQueued: false, challengeCache: null, index: null, status: freshStatus(), history: [] };
      runtimes.set(taskId, rt);
    }
    return rt;
  }

  function loadIndex(taskId) {
    const rt = runtimeFor(taskId);
    if (rt.index === null) rt.index = loadJson(indexFile(taskId), {});
    return rt.index;
  }

  function pushHistory(taskId, entry) {
    const rt = runtimeFor(taskId);
    rt.history.unshift({ ...entry, at: new Date().toISOString() });
    if (rt.history.length > HISTORY_LIMIT) rt.history = rt.history.slice(0, HISTORY_LIMIT);
  }

  function emitState(extra = {}) {
    try {
      onState({ ...getState(), ...extra });
    } catch {
      /* 推送失败不影响同步 */
    }
  }

  async function inviteTask(taskId) {
    const task = findTask(taskId);
    if (!task) return { ok: false, error: '同步任务不存在' };
    if (task.role !== 'master') return { ok: false, error: '只有主端任务可以邀请从端' };
    if (task.peerLinkedAt) return { ok: false, reason: 'ALREADY_LINKED', error: '该任务已与从端建立有效关联，无需重复邀请' };
    if (!task.peerAddress || !task.peerDeviceId) return { ok: false, error: '未指定从端设备' };
    try {
      const rt = runtimeFor(task.id);
      await authPayload(task, rt);
      const result = await post(task, '/api/sync/invite', {
        ...challengePayloadSync(task, rt),
        invite: {
          taskName: task.name || '同步任务',
          pairKey: task.pairKey,
          peerDeviceName: deviceName,
          peerPort: slaveServer?.port || syncPort,
        },
      });
      logEvent('info', 'sync', `已向从端发送同步任务邀请「${task.name || '未命名任务'}」`);
      return { ok: true, delivered: true, ...result };
    } catch (error) {
      logEvent('warn', 'sync', `同步任务已创建，但邀请从端失败：${error.message}`);
      return { ok: false, delivered: false, error: error.message };
    }
  }

  function getState() {
    return {
      tasks: tasks.map((task) => {
        const rt = runtimes.get(task.id);
        return {
          ...task,
          status: rt ? { ...rt.status } : freshStatus(),
          history: rt ? rt.history.slice(0, 30) : [],
        };
      }),
      serverPort: slaveServer ? slaveServer.port : null,
    };
  }

  const findTask = (id) => tasks.find((t) => t.id === id) || null;

  // ---------- 主端：与从端通信 ----------

  function baseUrl(task) {
    const port = Number(task.peerPort) || 7892;
    return `http://${task.peerAddress}:${port}`;
  }

  async function post(task, url, payload) {
    // 统一注入跨端关联键：从端按 pairKey（或兜底 taskId）匹配本端任务
    const requestBody = { ...payload, taskId: task.id, pairKey: task.pairKey || task.id };
    const response = await globalThis.fetch(`${baseUrl(task)}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
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
  async function authPayload(task, rt) {
    if (rt.challengeCache && rt.challengeCache.expiresAt > Date.now() + 30000) {
      return { signed: rt.challengeCache.signed, requesterId: deviceId };
    }
    const challenge = await post(task, '/api/sync/challenge', { requesterId: deviceId });
    const privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    const signed = signChallenge(challenge, privateKey);
    rt.challengeCache = { signed, expiresAt: challenge.expiresAt || Date.now() + 240000 };
    return { signed, requesterId: deviceId };
  }

  function challengePayloadSync(task, rt) {
    if (rt.challengeCache) return { signed: rt.challengeCache.signed, requesterId: deviceId };
    return { signed: null, requesterId: deviceId };
  }

  /** 停止通知（fire-and-forget）：通知失败不影响本端停止 */
  async function notifyPeer(task, event) {
    try {
      const rt = runtimeFor(task.id);
      await authPayload(task, rt).catch(() => { throw new Error('通知对端前取挑战失败'); });
      await post(task, '/api/sync/notify', { ...challengePayloadSync(task, rt), taskId: task.id, event });
    } catch (error) {
      logEvent('warn', 'sync', `通知对端（${event}）失败：${error.message}`);
    }
  }

  async function withRetry(fn, label, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error.status === 409) throw error; // 对端已停止：不重试，直接上抛
        if (attempt < attempts) await sleep(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  async function pushOne(task, rel) {
    const rt = runtimeFor(task.id);
    const abs = path.join(task.localRoot, rel);
    const stat = fs.statSync(abs);
    const size = stat.size;
    const sha256 = await hashFile(abs);
    const begin = await withRetry(
      async () => post(task, '/api/sync/begin', {
        ...(await authPayload(task, rt)),
        taskId: task.id, path: rel, size, mtimeMs: Math.round(stat.mtimeMs), sha256, chunkSize: Number(task.chunkSize) || DEFAULT_CHUNK_SIZE,
      }),
      `发起传输 ${rel}`,
      Number(task.maxAttempts) || 3,
    );
    const transferId = begin.transferId;
    const chunkSize = Number(task.chunkSize) || DEFAULT_CHUNK_SIZE;
    for (let i = 0; i < begin.chunkCount; i += 1) {
      const buf = readChunk(abs, i, chunkSize, size);
      const result = await withRetry(
        async () => post(task, '/api/sync/chunk', {
          ...(await authPayload(task, rt)),
          taskId: task.id, transferId, index: i, data: buf.toString('base64'),
        }),
        `推送分块 ${rel}#${i}`,
        Number(task.maxAttempts) || 3,
      );
      if (!result.ok) throw new Error(`分块 ${i} 未被接受`);
    }
    const commit = await withRetry(
      async () => post(task, '/api/sync/commit', { ...(await authPayload(task, rt)), taskId: task.id, transferId }),
      `提交 ${rel}`,
      Number(task.maxAttempts) || 3,
    );
    return commit;
  }

  // ---------- 主端：一轮同步 ----------

  async function runCycle(taskId, { fullScan = false, reason = 'manual' } = {}) {
    const task = findTask(taskId);
    if (!task) return { ok: false, reason: 'NO_TASK', error: '同步任务不存在' };
    if (task.role !== 'master') return { ok: false, reason: 'NOT_MASTER', error: '仅主端任务可执行同步' };
    if (!task.enabled) return { ok: false, reason: 'TASK_STOPPED', error: '该同步任务未启动' };
    const rt = runtimeFor(taskId);
    if (rt.cycleRunning) { rt.cycleQueued = true; return { ok: true, queued: true }; }
    rt.cycleRunning = true;
    rt.status = { ...rt.status, running: true, currentFile: '', peerStopped: false };

    const summary = { pushed: 0, trashed: 0, failed: 0, skipped: 0, fullScan, reason };
    const failedRels = [];
    try {
      if (!task.localRoot) throw new Error('本端目录未配置');
      if (!task.peerAddress || !task.peerDeviceId) throw new Error('未指定从端设备');
      // 先把挑战取到手，后续 list/trash/purge 才能直接复用（周期内会自动续签）
      await authPayload(task, rt);

      const matcher = buildIgnoreMatcher(task.ignore);
      const ignoredDeletionFilter = task.cleanupIgnoredOnSlave ? () => false : matcher;
      const current = scanTree(task.localRoot, {
        ignore: (rel, isDir) => isInternalPath(rel) || matcher(rel, isDir),
      });
      // 排除项是否视为失效由任务配置决定；默认保留从端内容，避免因新增规则误清理数据。
      const index = loadIndex(taskId);
      const plan = computePlan(current, index, ignoredDeletionFilter);
      const toTrash = [...plan.toTrash];

      // 全量校验轮：拿从端清单比对，把从端多出来的文件也清掉
      if (fullScan) {
        const remote = await withRetry(
          async () => post(task, '/api/sync/list', { ...(await authPayload(task, rt)), taskId }),
          '拉取从端清单',
          Number(task.maxAttempts) || 3,
        );
        if (!task.peerLinkedAt) {
          task.peerLinkedAt = new Date().toISOString();
          persistTasks();
        }
        const remoteFiles = Array.isArray(remote.files) ? remote.files : [];
        const remoteByPath = new Map(remoteFiles.map((file) => [normalizeRelPath(file.path), file]));
        for (const [rel, meta] of current) {
          const peer = remoteByPath.get(rel);
          const mtimeDiff = peer ? Math.abs(Number(peer.mtimeMs) - Number(meta.mtimeMs)) : Infinity;
          if ((!peer || Number(peer.size) !== meta.size || !Number.isFinite(mtimeDiff) || mtimeDiff > 2000) && !plan.toPush.includes(rel)) {
            plan.toPush.push(rel);
          }
        }
        plan.toPush.sort();
        const extras = extrasOnSlave(current, remoteFiles.map((f) => f.path), ignoredDeletionFilter);
        for (const rel of extras) {
          if (!toTrash.includes(rel)) toTrash.push(rel);
        }
        summary.extras = extras.length;
      }

      for (const rel of plan.toPush) {
        // 停止联动：任务被停止时立刻中止本轮，不再继续推送
        if (!task.enabled) throw Object.assign(new Error('任务已停止，本轮中止'), { cancelled: true });
        rt.status = { ...rt.status, currentFile: rel, pending: plan.toPush.length - summary.pushed };
        emitState();
        try {
          await withRetry(() => pushOne(task, rel), `推送 ${rel}`, Number(task.maxAttempts) || 3);
          summary.pushed += 1;
          pushHistory(taskId, { kind: 'push', path: rel, ok: true });
        } catch (error) {
          if (error.cancelled) throw error;
          // 文件在读取瞬间被删/被占：记一笔，下轮再试，不让整轮崩掉
          if (!fs.existsSync(path.join(task.localRoot, rel))) {
            summary.skipped += 1;
            pushHistory(taskId, { kind: 'push', path: rel, ok: false, message: '文件已不存在，跳过' });
            continue;
          }
          if (error.status === 409) {
            // 对端已停止：整轮中断，保留索引等待补偿
            pushHistory(taskId, { kind: 'cycle', ok: false, message: `对端已停止同步任务：${error.message}` });
            throw error;
          }
          summary.failed += 1;
          failedRels.push(rel);
          pushHistory(taskId, { kind: 'push', path: rel, ok: false, message: error.message });
          logEvent('error', 'sync', `推送 ${rel} 失败：${error.message}`);
        }
      }

      const failedTrashRels = [];
      if (toTrash.length) {
        try {
          const result = await withRetry(
            async () => post(task, '/api/sync/trash', { ...(await authPayload(task, rt)), taskId, paths: toTrash }),
            '清理从端失效文件',
            Number(task.maxAttempts) || 3,
          );
          summary.trashed = (result.moved || []).length;
          for (const rel of result.moved || []) pushHistory(taskId, { kind: 'trash', path: rel, ok: true });
        } catch (error) {
          if (error.status !== 409) {
            summary.failed += toTrash.length;
            failedTrashRels.push(...toTrash);
            logEvent('error', 'sync', `清理从端失效文件失败：${error.message}`);
            pushHistory(taskId, { kind: 'trash', path: `${toTrash.length} 个文件`, ok: false, message: error.message });
          }
        }
      }

      try {
        await post(task, '/api/sync/purge', { ...(await authPayload(task, rt)), taskId, retentionDays: Number(task.trashRetentionDays) });
      } catch (error) {
        if (error.status !== 409) logEvent('warn', 'sync', `清理从端过期回收区失败（不影响同步）：${error.message}`);
      }

      // 失败补偿：索引只记录真正成功同步过的状态；失败的文件保留旧快照，下轮自动重推
      const nextIndex = carryFailures(toIndex(current), index, failedRels);
      // 删除/回收失败也必须保留待办标记；否则旧路径从索引消失后，下一轮不会再次产生 toTrash。
      for (const rel of failedTrashRels) nextIndex[rel] = index[rel] || { size: -1, mtimeMs: -1 };
      rt.index = nextIndex;
      persistIndex(taskId, nextIndex);
      rt.status = { ...rt.status, lastSyncAt: new Date().toISOString(), lastError: null, fileCount: current.size, pendingRetry: failedRels.length + failedTrashRels.length };
      pushHistory(taskId, {
        kind: 'cycle', ok: true,
        message: `推送 ${summary.pushed}，回收 ${summary.trashed}，失败 ${summary.failed}${failedRels.length ? `（待补偿 ${failedRels.length}）` : ''}`,
      });
      logEvent('info', 'sync', `同步完成（${reason}）：推送 ${summary.pushed}，回收 ${summary.trashed}，失败 ${summary.failed}`);
      return { ok: true, ...summary };
    } catch (error) {
      const isPeerStopped = error.status === 409;
      const isCancelled = Boolean(error.cancelled);
      if (!isCancelled) {
        rt.status = { ...rt.status, lastError: error.message, peerStopped: isPeerStopped };
        pushHistory(taskId, { kind: 'cycle', ok: false, message: isPeerStopped ? '对端已停止该同步任务' : error.message });
        logEvent('error', 'sync', `同步失败（${reason}）：${error.message}`);
      } else {
        pushHistory(taskId, { kind: 'cycle', ok: true, message: '任务已停止，本轮同步中止' });
        logEvent('info', 'sync', `任务已停止，本轮同步中止（${reason}）`);
      }
      return { ok: false, error: error.message, cancelled: isCancelled, peerStopped: isPeerStopped, ...summary };
    } finally {
      rt.cycleRunning = false;
      rt.status = { ...rt.status, running: false, currentFile: '', pending: 0 };
      emitState();
      if (rt.cycleQueued) {
        rt.cycleQueued = false;
        setTimeout(() => runCycle(taskId, { fullScan: true, reason: 'queued' }), 200);
      }
    }
  }

  // ---------- 主端：监听与轮询 ----------

  function scheduleCycle(task, fullScan) {
    const rt = runtimeFor(task.id);
    if (rt.debounceTimer) clearTimeout(rt.debounceTimer);
    rt.debounceTimer = setTimeout(() => {
      rt.debounceTimer = null;
      runCycle(task.id, { fullScan, reason: fullScan ? 'full-scan' : 'watch' }).catch(() => {});
    }, Math.max(100, Number(task.debounceMs) || 800));
  }

  function startWatcher(task) {
    stopWatcher(task.id);
    if (!task.localRoot) return;
    const rt = runtimeFor(task.id);
    try {
      rt.watcher = fs.watch(task.localRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = normalizeRelPath(filename);
        // 回收区/暂存区的写入是自己造成的，不能反过来触发同步
        if (!rel || rel.startsWith(TRASH_DIR) || rel.startsWith(INCOMING_DIR)) return;
        scheduleCycle(task, false);
      });
      logEvent('info', 'sync', `已监听目录「${task.name}」：${task.localRoot}`);
    } catch (error) {
      logEvent('error', 'sync', `监听目录失败：${error.message}（将依赖定时校验）`);
    }
  }

  function stopWatcher(taskId) {
    const rt = runtimes.get(taskId);
    if (!rt) return;
    if (rt.watcher) { try { rt.watcher.close(); } catch { /* 已关闭 */ } rt.watcher = null; }
    if (rt.debounceTimer) { clearTimeout(rt.debounceTimer); rt.debounceTimer = null; }
  }

  function startPolling(task) {
    stopPolling(task.id);
    const rt = runtimeFor(task.id);
    const interval = Math.max(30000, Number(task.fullScanMs) || 300000);
    rt.pollTimer = setInterval(() => runCycle(task.id, { fullScan: true, reason: 'poll' }).catch(() => {}), interval);
  }

  function stopPolling(taskId) {
    const rt = runtimes.get(taskId);
    if (rt && rt.pollTimer) { clearInterval(rt.pollTimer); rt.pollTimer = null; }
  }

  // ---------- 从端：本地回收区维护（按任务） ----------

  function trashRoot(task) {
    return task.localRoot ? path.join(task.localRoot, TRASH_DIR) : '';
  }

  function listTrash(taskId) {
    const task = findTask(taskId);
    if (!task) throw new Error('同步任务不存在');
    const root = trashRoot(task);
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

  function restoreFromTrash(taskId, stamp, rel) {
    const task = findTask(taskId);
    if (!task) throw new Error('同步任务不存在');
    const root = trashRoot(task);
    if (!root) throw new Error('本端目录未配置');
    const source = path.join(root, String(stamp), normalizeRelPath(rel));
    const dest = path.join(task.localRoot, normalizeRelPath(rel));
    if (!fs.existsSync(source)) throw new Error('回收区中找不到该文件');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(source, dest);
    logEvent('info', 'sync', `已从回收区恢复 ${rel}`);
    return { ok: true, path: normalizeRelPath(rel) };
  }

  function purgeTrash(taskId, { all = false, retentionDays } = {}) {
    const task = findTask(taskId);
    if (!task) throw new Error('同步任务不存在');
    const root = trashRoot(task);
    if (!root || !fs.existsSync(root)) return { purged: [] };
    const entries = fs.readdirSync(root);
    const targets = all
      ? entries.filter((name) => parseTrashStamp(name) !== null)
      : purgeStamps(entries, retentionDays ?? Number(task.trashRetentionDays));
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

  function persistIndex(taskId, index) {
    saveJson(indexFile(taskId), index);
  }

  // ---------- 生命周期：对齐运行时与任务配置 ----------

  function stopRuntime(taskId) {
    stopWatcher(taskId);
    stopPolling(taskId);
    const rt = runtimes.get(taskId);
    if (rt) rt.status = { ...rt.status, started: false, running: false, currentFile: '', pending: 0 };
  }

  async function apply() {
    // 停掉不再启用/角色变化的主端任务运行时（保留 runtime 记录历史，removeTask 才彻底删除）
    for (const [id] of [...runtimes.entries()]) {
      const task = findTask(id);
      if (!task || !task.enabled || task.role !== 'master') stopRuntime(id);
    }
    // 启动启用的主端任务
    for (const task of tasks) {
      if (task.enabled && task.role === 'master' && !runtimes.get(task.id)?.status?.started) {
        const rt = runtimeFor(task.id);
        rt.status = { ...rt.status, started: true, peerStopped: false };
        startWatcher(task);
        startPolling(task);
        runCycle(task.id, { fullScan: true, reason: 'start' }).catch(() => {});
      }
    }
    // 所有运行中的任务共享一个通知监听端口；从端额外在此端口接收文件同步请求。
    // 这样无论主端还是从端停止任务，都能即时通知另一端当前界面。
    if (!slaveServer) {
      slaveServer = await startServer({
        port: syncPort,
        deviceId,
        lookupTrustedPublicKey,
        createChallenge: ({ deviceId: did, requesterId }) => createChallenge({ deviceId: did, requesterId }),
        onEvent: ({ level, message }) => logEvent(level, 'sync', message),
        onAccess,
        // 对端通知写入任务历史，并带 notice 推送到应用根层弹出提示框。
        onNotify: (key, event) => {
          const t = tasks.find((x) => x.pairKey === key || x.id === key);
          if (!t) return;
          const message = event === 'stopped' ? '对端已停止该同步任务' : `对端通知：${event}`;
          pushHistory(t.id, { kind: 'notify', ok: true, message });
          logEvent('info', 'sync', `任务「${t.name}」${message}`);
          emitState({ notice: { type: `sync-${event}`, taskId: t.id, taskName: t.name, message: `对端已停止同步任务「${t.name || '未命名任务'}」。` } });
        },
        onInvite: (invitation) => {
          logEvent('info', 'sync', `收到来自 ${invitation.peerDeviceName || invitation.peerAddress} 的同步邀请「${invitation.taskName}」`);
          emitState({ invitation });
        },
        getNotifyTask: (key) => {
          const k = String(key || '');
          const hit = tasks.find((t) => t.enabled && ((t.pairKey && t.pairKey === k) || t.id === k));
          return hit ? { name: hit.name || '未命名任务' } : null;
        },
        getTask: (key) => {
          const k = String(key || '');
          const slaves = tasks.filter((t) => t.role === 'slave');
          const wrap = (t) => ({ name: t.name, localRoot: t.enabled ? t.localRoot : '', trashRetentionDays: t.trashRetentionDays });
          // 1) 精确配对码 / 任务 ID
          const hit = slaves.find((t) => (t.pairKey && t.pairKey === k) || t.id === k);
          if (hit) return wrap(hit);
          // 2) 兜底：仅一条未设配对码的从端任务时接受任意 key（兼容旧版单任务迁移）
          const unkeyed = slaves.filter((t) => !t.pairKey);
          if (unkeyed.length === 1) return wrap(unkeyed[0]);
          return null;
        },
      });
      logEvent('info', 'sync', `从端同步服务已启动：${slaveServer.port}`);
    }
    // 从端任务的运行时状态对齐（从端无 watcher，仅 started 标志）
    for (const task of tasks) {
      if (task.role === 'slave' && task.enabled) {
        const rt = runtimeFor(task.id);
        rt.status = { ...rt.status, started: true };
      } else if (task.role === 'slave' && !task.enabled) {
        const rt = runtimes.get(task.id);
        if (rt) rt.status = { ...rt.status, started: false };
      }
    }
    persistTasks();
    emitState();
    return { ok: true };
  }

  // ---------- 对外 API ----------

  function assertStopped(task) {
    if (task.enabled) throw new Error('该同步任务正在运行，请先停止后再修改配置');
  }

  return {
    listTasks: () => getState().tasks,
    addTask: (patch = {}) => {
      const task = normalizeTask({ ...DEFAULT_TASK, ...patch, id: newTaskId(), enabled: false });
      if (task.role === 'master' && !task.pairKey) task.pairKey = newPairKey();
      tasks.push(task);
      persistTasks();
      emitState();
      return task;
    },
    inviteTask,
    updateTask: (id, patch = {}) => {
      const task = findTask(id);
      if (!task) throw new Error('同步任务不存在');
      assertStopped(task); // 运行中的任务不可改配置
      const next = normalizeTask({ ...task, ...patch, id: task.id, enabled: task.enabled, role: task.role });
      if (task.role === 'master' && (
        next.peerDeviceId !== task.peerDeviceId
        || next.peerAddress !== task.peerAddress
        || Number(next.peerPort) !== Number(task.peerPort)
        || next.pairKey !== task.pairKey
      )) next.peerLinkedAt = null;
      tasks = tasks.map((t) => (t.id === id ? next : t));
      persistTasks();
      emitState();
      return next;
    },
    removeTask: (id) => {
      const task = findTask(id);
      if (!task) throw new Error('同步任务不存在');
      assertStopped(task); // 运行中的任务不可删除
      tasks = tasks.filter((t) => t.id !== id);
      stopRuntime(id);
      runtimes.delete(id);
      try { fs.rmSync(indexFile(id), { force: true }); } catch { /* 索引清理失败不影响 */ }
      persistTasks();
      emitState();
      return { ok: true };
    },
    startTask: (id) => {
      const task = findTask(id);
      if (!task) throw new Error('同步任务不存在');
      task.enabled = true;
      persistTasks();
      emitState();
      return apply();
    },
    stopTask: async (id) => {
      const task = findTask(id);
      if (!task) throw new Error('同步任务不存在');
      task.enabled = false;
      persistTasks();
      await apply();
      if (task.peerAddress && task.peerDeviceId) {
        // 主端或从端停止 → 主动通知另一端
        await notifyPeer(task, 'stopped');
      }
      return { ok: true };
    },
    runNow: (id) => runCycle(id, { fullScan: true, reason: 'manual' }),
    resetIndex: (id) => {
      const rt = runtimeFor(id);
      rt.index = {};
      persistIndex(id, {});
      pushHistory(id, { kind: 'cycle', ok: true, message: '已清空该任务的同步索引，下次同步将全量比对' });
      logEvent('info', 'sync', '已清空同步索引，下次同步将全量比对');
      emitState();
      return { ok: true };
    },
    trash: (id) => listTrash(id),
    restore: (id, payload = {}) => restoreFromTrash(id, payload.stamp, payload.path),
    purgeTrash: (id, opts = {}) => purgeTrash(id, opts),
    getState,
    apply,
    port: () => slaveServer ? slaveServer.port : null,
    dispose: async () => {
      for (const [id] of [...runtimes.entries()]) stopRuntime(id);
      runtimes.clear();
      if (slaveServer) { try { await slaveServer.close(); } catch { /* 已关闭 */ } slaveServer = null; }
    },
  };
}

module.exports = { createSyncService, DEFAULT_TASK };
