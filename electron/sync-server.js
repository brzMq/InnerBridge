/**
 * 文件夹同步的从端服务。
 *
 * 与 P2P 传输（transfer-server）的区别：那边是「提议 → 接收端弹窗确认 → 分块」，
 * 需要人工点一次；同步要求无人值守，所以这里是一组免确认端点，
 * 鉴权改为复用配对时交换的 Ed25519 公钥验签（与共享清单接口同一套机制）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashFile } = require('../core/transfer');
const { verifyChallenge } = require('../core/light-auth');
const {
  INCOMING_DIR, TRASH_DIR, chunkPlan, isInternalPath, normalizeRelPath, purgeStamps, scanTree, trashDestination,
} = require('../core/sync-engine');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > max) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(JSON.parse(text || '{}')));
    req.on('error', reject);
  });
}

/** 把主端给的相对路径限制在 root 内，挡住 ../ 穿越和绝对路径 */
function safeTarget(root, rel) {
  const norm = normalizeRelPath(rel);
  if (!norm || norm === '..' || norm.startsWith('../')) return null;
  if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('/')) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, norm);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function makeAuthorized({ deviceId, lookupTrustedPublicKey }) {
  return function authorized(signed, requesterId) {
    const rid = String(requesterId || '');
    if (!rid || !signed) return false;
    const stored = typeof lookupTrustedPublicKey === 'function' ? lookupTrustedPublicKey(rid) : null;
    if (!stored) return false;
    try {
      const key = typeof stored === 'string' ? crypto.createPublicKey(stored) : stored;
      return verifyChallenge(signed, key, { deviceId, requesterId: rid });
    } catch {
      return false;
    }
  };
}

function startSyncServer({ port = 7892, host = '0.0.0.0', root, deviceId, lookupTrustedPublicKey, createChallenge, onEvent } = {}) {
  if (!deviceId) return Promise.reject(new Error('deviceId 未配置'));
  if (!root) return Promise.reject(new Error('从端同步目录未配置'));
  fs.mkdirSync(root, { recursive: true });

  const authorized = makeAuthorized({ deviceId, lookupTrustedPublicKey });
  const sessions = new Map();
  const incomingDir = path.join(root, INCOMING_DIR);
  const trashDir = path.join(root, TRASH_DIR);

  const emit = (level, message) => { try { onEvent && onEvent({ level, source: 'sync', message }); } catch { /* 日志失败不影响同步 */ } };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // 挑战只对已配对设备下发，避免向未知设备泄露本机 deviceId
      if (req.method === 'POST' && url.pathname === '/api/sync/challenge') {
        const { requesterId } = await readJson(req);
        const rid = String(requesterId || '');
        const stored = typeof lookupTrustedPublicKey === 'function' ? lookupTrustedPublicKey(rid) : null;
        if (!rid || !stored) return json(res, 403, { error: '设备未获信任' });
        return json(res, 200, createChallenge({ deviceId, requesterId: rid }));
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/list') {
        const { signed, requesterId } = await readJson(req);
        if (!authorized(signed, requesterId)) return json(res, 403, { error: '设备未获信任' });
        const files = [...scanTree(root)].map(([rel, meta]) => ({ path: rel, size: meta.size, mtimeMs: meta.mtimeMs }));
        return json(res, 200, { ok: true, files });
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/begin') {
        const { signed, requesterId, path: rel, size, sha256, chunkSize } = await readJson(req);
        if (!authorized(signed, requesterId)) return json(res, 403, { error: '设备未获信任' });
        const target = safeTarget(root, rel);
        if (!target) return json(res, 400, { error: '目标路径无效' });
        if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) return json(res, 400, { error: '校验和无效' });
        const plan = chunkPlan(Number(size), Number(chunkSize));
        const transferId = `sync_${crypto.randomBytes(12).toString('hex')}`;
        fs.mkdirSync(incomingDir, { recursive: true });
        const tmp = path.join(incomingDir, `${transferId}.part`);
        const fd = fs.openSync(tmp, 'w');
        fs.ftruncateSync(fd, plan.size);
        fs.closeSync(fd);
        sessions.set(transferId, { transferId, target, tmp, sha256: String(sha256).toLowerCase(), ...plan, received: new Set() });
        return json(res, 200, { ok: true, transferId, chunkCount: plan.chunkCount, missing: [...Array(plan.chunkCount).keys()] });
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/chunk') {
        const { signed, requesterId, transferId, index, data } = await readJson(req);
        if (!authorized(signed, requesterId)) return json(res, 403, { error: '设备未获信任' });
        const session = sessions.get(String(transferId || ''));
        const i = Number(index);
        if (!session || !Number.isInteger(i) || i < 0 || i >= session.chunkCount) return json(res, 400, { error: '分块序号无效' });
        const buf = Buffer.from(String(data || ''), 'base64');
        const expected = Math.min(session.chunkSize, session.size - i * session.chunkSize);
        if (buf.length !== expected) return json(res, 400, { error: '分块大小不符' });
        const fd = fs.openSync(session.tmp, 'r+');
        fs.writeSync(fd, buf, 0, buf.length, i * session.chunkSize);
        fs.closeSync(fd);
        session.received.add(i);
        const missing = [...Array(session.chunkCount).keys()].filter((n) => !session.received.has(n));
        return json(res, 200, { ok: true, missing });
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/commit') {
        const { signed, requesterId, transferId } = await readJson(req);
        if (!authorized(signed, requesterId)) return json(res, 403, { error: '设备未获信任' });
        const session = sessions.get(String(transferId || ''));
        if (!session) return json(res, 400, { error: '传输会话不存在' });
        const missing = [...Array(session.chunkCount).keys()].filter((n) => !session.received.has(n));
        if (missing.length) return json(res, 400, { error: '分块尚未收齐', missing });
        const digest = await hashFile(session.tmp);
        if (digest !== session.sha256) {
          sessions.delete(session.transferId);
          try { fs.unlinkSync(session.tmp); } catch { /* 已不存在就算了 */ }
          return json(res, 400, { error: '校验和不匹配，已丢弃' });
        }
        fs.mkdirSync(path.dirname(session.target), { recursive: true });
        fs.renameSync(session.tmp, session.target);
        sessions.delete(session.transferId);
        emit('info', `已同步 ${path.relative(root, session.target)}`);
        return json(res, 200, { ok: true, path: path.relative(root, session.target).split(path.sep).join('/') });
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/trash') {
        const { signed, requesterId, paths } = await readJson(req);
        if (!authorized(signed, requesterId)) return json(res, 403, { error: '设备未获信任' });
        if (!Array.isArray(paths)) return json(res, 400, { error: '参数无效' });
        const moved = [];
        const skipped = [];
        for (const rel of paths) {
          const source = safeTarget(root, rel);
          if (!source) { skipped.push(String(rel)); continue; }
          if (!fs.existsSync(source)) { skipped.push(String(rel)); continue; }
          const dest = path.join(root, trashDestination(rel));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(source, dest);
          moved.push(normalizeRelPath(rel));
        }
        if (moved.length) emit('info', `已移入回收区 ${moved.length} 个文件`);
        return json(res, 200, { ok: true, moved, skipped });
      }

      if (req.method === 'POST' && url.pathname === '/api/sync/purge') {
        const { signed, requesterId, retentionDays } = await readJson(req);
        if (!authorized(signed, requesterId)) return json(res, 403, { error: '设备未获信任' });
        let entries = [];
        try { entries = fs.readdirSync(trashDir); } catch { entries = []; }
        const purged = [];
        for (const stamp of purgeStamps(entries, Number(retentionDays))) {
          try { fs.rmSync(path.join(trashDir, stamp), { recursive: true, force: true }); purged.push(stamp); } catch { /* 个别失败不阻断 */ }
        }
        if (purged.length) emit('info', `已清理 ${purged.length} 个过期回收批次`);
        return json(res, 200, { ok: true, purged });
      }

      return json(res, 404, { error: 'not found' });
    } catch (error) {
      return json(res, 400, { error: String(error.message || error) });
    }
  });

  return new Promise((resolve, reject) => {
    const listen = (candidate) => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && candidate < port + 10) return listen(candidate + 1);
        reject(error);
      });
      server.listen(candidate, host, () => {
        resolve({
          server,
          port: server.address().port,
          host,
          root,
          dropSession: (transferId) => sessions.delete(String(transferId || '')),
          close: () => new Promise((done) => server.close(done)),
        });
      });
    };
    listen(port);
  });
}

module.exports = { startSyncServer, safeTarget, isInternalPath };
