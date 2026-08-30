const http = require('http'); const fs = require('fs'); const path = require('path');
const { hashFile, markChunk } = require('../core/transfer');
const SAFE_ID = /^transfer_[a-f0-9]{24}$/;
function jsonResponse(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function readJson(req, max = 128 * 1024) { return new Promise((resolve, reject) => { let text = ''; req.on('data', (chunk) => { text += chunk; if (text.length > max) { reject(new Error('request too large')); req.destroy(); } }); req.on('end', () => resolve(JSON.parse(text || '{}'))); req.on('error', reject); }); }
function safeFileName(value) { return path.basename(String(value || '')).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 180) || 'received.bin'; }
function validManifest(manifest) {
  if (!manifest || !SAFE_ID.test(String(manifest.transferId || '')) || !manifest.senderId || !manifest.receiverId) return false;
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) return false;
  if (!Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize < 64 * 1024 || manifest.chunkSize > 64 * 1024 * 1024) return false;
  if (manifest.chunkCount !== Math.max(1, Math.ceil(manifest.size / manifest.chunkSize))) return false;
  return /^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ''));
}
function availableTarget(dir, name) {
  const parsed = path.parse(safeFileName(name));
  let candidate = path.join(dir, parsed.base);
  for (let index = 1; fs.existsSync(candidate); index += 1) candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`);
  return candidate;
}
function startTransferServer({ port = 49152, host = '0.0.0.0', root, sessions = new Map(), authorize = () => false, authorizeOffer = authorize, authorizeStatus = authorize, verifyOfferChallenge = null, finalizeReceived = null, onOffer } = {}) {
  if (!root) return Promise.reject(new Error('传输目录未配置')); fs.mkdirSync(root, { recursive: true });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); const parts = url.pathname.split('/').filter(Boolean); const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    try {
      if (req.method === 'POST' && url.pathname === '/api/transfer/offer') { const body = await readJson(req); const manifest = body.manifest; const challengeOk = !verifyOfferChallenge || (body.signedChallenge && verifyOfferChallenge(body.signedChallenge, manifest)); if (!validManifest(manifest) || !authorizeOffer(manifest, bearer, req) || !challengeOk) return jsonResponse(res, 403, { error: '传输提议未获授权' }); manifest.name = safeFileName(manifest.name); const state = { manifest, state: 'offered', received: new Set(), senderName: String(body.senderName || manifest.senderId).slice(0, 80), targetDir: '', offerToken: bearer }; sessions.set(manifest.transferId, state); try { onOffer && onOffer({ transferId: manifest.transferId, manifest, senderName: state.senderName }); } catch { /* 通知失败不影响会话 */ } return jsonResponse(res, 200, { ok: true, transferId: manifest.transferId, state: state.state }); }
      if (req.method === 'GET' && url.pathname.startsWith('/api/transfer/status/')) { const state = sessions.get(decodeURIComponent(url.pathname.slice('/api/transfer/status/'.length))); if (!state || !authorizeStatus(state.manifest, bearer, req)) return jsonResponse(res, 403, { error: '传输状态未获授权' }); return jsonResponse(res, 200, { ok: true, transferId: state.manifest.transferId, state: state.state, error: state.error || '', targetDir: state.state === 'completed' ? state.targetDir : undefined }); }
      if (req.method === 'POST' && url.pathname === '/api/transfer/decision') return jsonResponse(res, 403, { error: '接收决定必须在接收端本机确认' });
      if (req.method === 'POST' && parts[0] === 'transfer' && parts[2] === 'chunk') { const id = parts[1]; const state = sessions.get(id); const index = Number(req.headers['x-chunk-index']); if (!SAFE_ID.test(id) || !state || state.state !== 'accepted' || !authorize(state.manifest, bearer, req) || !Number.isInteger(index) || index < 0 || index >= state.manifest.chunkCount) return jsonResponse(res, 403, { error: '分块未获授权' }); const size = Math.min(state.manifest.chunkSize, state.manifest.size - index * state.manifest.chunkSize); if (Number(req.headers['content-length']) !== size) return jsonResponse(res, 400, { error: '分块大小无效' }); const tmp = path.join(root, `${id}.part`); if (!fs.existsSync(tmp)) { const fd = fs.openSync(tmp, 'w'); fs.ftruncateSync(fd, state.manifest.size); fs.closeSync(fd); } const out = fs.createWriteStream(tmp, { flags: 'r+', start: index * state.manifest.chunkSize }); req.pipe(out); out.on('finish', async () => { try { markChunk(state, index); const missing = [...Array(state.manifest.chunkCount).keys()].filter((i) => !state.received.has(i)); if (missing.length) return jsonResponse(res, 200, { ok: true, missing }); state.state = 'verifying'; const digest = await hashFile(tmp); if (digest !== String(state.manifest.sha256 || '').toLowerCase()) throw new Error('文件校验失败'); fs.mkdirSync(state.targetDir, { recursive: true }); let targetFile; if (finalizeReceived) targetFile = await finalizeReceived({ tmp, state, availableTarget }); else { targetFile = availableTarget(state.targetDir, state.manifest.name); fs.renameSync(tmp, targetFile); } state.state = 'completed'; state.targetFile = targetFile; return jsonResponse(res, 200, { ok: true, missing: [], completed: true, targetFile }); } catch (error) { state.state = 'failed'; state.error = String(error.message || error); try { fs.unlinkSync(tmp); } catch { /* ignore */ } return jsonResponse(res, 400, { error: state.error }); } }); out.on('error', () => jsonResponse(res, 500, { error: '写入失败' })); return; }
      return jsonResponse(res, 404, { error: 'not found' });
    } catch (error) { return jsonResponse(res, 400, { error: String(error.message || error) }); }
  });
  function decide(transferId, accepted, targetDir, token) { const state = sessions.get(String(transferId || '')); if (!state) return { ok: false, reasonCode: 'SESSION_NOT_FOUND' }; if (state.state !== 'offered') return { ok: false, reasonCode: 'SESSION_ALREADY_DECIDED' }; if (!accepted) { state.state = 'cancelled'; return { ok: true, state: state.state }; } if (!targetDir || !authorize(state.manifest, token, null)) return { ok: false, reasonCode: 'DECISION_NOT_AUTHORIZED' }; state.state = 'accepted'; state.targetDir = path.resolve(String(targetDir)); state.token = String(token); return { ok: true, state: state.state }; }
  return new Promise((resolve, reject) => {
    const listen = (candidate) => {
      const onError = (error) => { if (error.code === 'EADDRINUSE' && candidate < port + 10) return listen(candidate + 1); reject(error); };
      server.once('error', onError);
      server.listen(candidate, host, () => resolve({ server, port: server.address().port, host, root, sessions, decide, close: () => new Promise((done) => server.close(done)) }));
    };
    listen(port);
  });
}
module.exports = { startTransferServer, SAFE_ID, validManifest };
