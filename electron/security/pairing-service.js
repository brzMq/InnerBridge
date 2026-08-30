const http = require('http');
const { createPairingCoordinator } = require('../../core/pairing-coordinator');
const { createTransferChallenge } = require('../../core/transfer');
const { verifyRevocation } = require('../../core/revocation');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; if (text.length > 16 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(text)); req.on('error', reject);
  });
}
function startPairingServer({ port = 7891, deviceId, identityFingerprint = '', identityPublicKey = '', onRequest, lookupTrustedPublicKey, onRevoked } = {}) {
  if (!deviceId) return Promise.reject(new Error('deviceId is required'));
  const pairing = createPairingCoordinator();
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/pair/request') {
      try {
        const input = JSON.parse((await bodyOf(req)) || '{}'); const fromDeviceId = String(input.fromDeviceId || ''); const toDeviceId = String(input.toDeviceId || '');
        if (!fromDeviceId || toDeviceId !== deviceId) return json(res, 404, { error: '目标设备不存在' });
        const result = pairing.request(fromDeviceId, toDeviceId);
        const request = { sessionId: result.sessionId, fromDeviceId, fromDeviceName: String(input.fromDeviceName || fromDeviceId).slice(0, 80), fromFingerprint: String(input.fromFingerprint || '').slice(0, 256), fromPublicKey: String(input.fromPublicKey || '').slice(0, 4096), expiresAt: result.expiresAt, state: 'pending' };
        sessions.set(result.sessionId, { ...request, code: result.code }); try { onRequest && onRequest({ ...request, code: result.code }); } catch { /* UI 通知异常不影响会话 */ }
        return json(res, 200, { ok: true, sessionId: result.sessionId, code: result.code, expiresAt: result.expiresAt });
      } catch (error) { return json(res, 400, { error: String(error.message || error) }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/pair/status/')) {
      const item = sessions.get(decodeURIComponent(url.pathname.slice('/api/pair/status/'.length)));
      if (!item) return json(res, 404, { error: '配对会话不存在' });
      if (item.state === 'pending' && Date.now() >= item.expiresAt) item.state = 'expired';
      return json(res, 200, { ok: true, sessionId: item.sessionId, state: item.state, expiresAt: item.expiresAt, ...(item.state === 'accepted' ? { identityFingerprint, identityPublicKey, authorization: item.authorization } : {}) });
    }
    if (req.method === 'POST' && url.pathname === '/api/pair/transfer-challenge') { try { const input = JSON.parse((await bodyOf(req)) || '{}'); const senderId = String(input.senderId || ''); const senderPub = typeof lookupTrustedPublicKey === 'function' ? lookupTrustedPublicKey(senderId) : null; if (!senderId || !senderPub) return json(res, 403, { error: '设备未获信任' }); const challenge = createTransferChallenge({ transferId: String(input.transferId || ''), senderId, receiverId: deviceId }); return json(res, 200, { ok: true, challenge }); } catch (error) { return json(res, 400, { error: String(error.message || error) }); } }
    // 对端解除信任时主动送达。只认本机信任过的设备，并用配对时留存的公钥验签，
    // 否则局域网内任何人都能伪造撤销把两端的配对拆掉。
    if (req.method === 'POST' && url.pathname === '/api/pair/revoke') {
      try {
        const input = JSON.parse((await bodyOf(req)) || '{}');
        const revokerId = String(input.signed?.revocation?.deviceId || '');
        const publicKey = typeof lookupTrustedPublicKey === 'function' ? lookupTrustedPublicKey(revokerId) : null;
        if (!publicKey) return json(res, 403, { error: '设备未获信任' });
        if (!verifyRevocation(input.signed, publicKey, { targetDeviceId: deviceId })) return json(res, 403, { error: '撤销签名校验失败' });
        const result = onRevoked ? onRevoked({ deviceId: revokerId, deviceName: String(input.signed.revocation?.deviceName || '') }) : { ok: true };
        return json(res, 200, { ok: true, ...result });
      } catch (error) { return json(res, 400, { error: String(error.message || error) }); }
    }
    return json(res, 404, { error: 'not found' });
  });
  function confirm(sessionId, code) {
    const item = sessions.get(sessionId); if (!item) return { ok: false, reasonCode: 'SESSION_NOT_FOUND' };
    const result = pairing.confirm(sessionId, deviceId, code, item.fromFingerprint || item.fromDeviceId);
    item.state = result.ok ? 'accepted' : (result.reasonCode === 'EXPIRED' ? 'expired' : 'pending');
    if (result.ok) item.authorization = result.authorization;
    return { ok: result.ok, reasonCode: result.reasonCode, state: item.state, remoteDeviceId: item.fromDeviceId, remoteFingerprint: item.fromFingerprint, remotePublicKey: item.fromPublicKey, authorization: result.authorization };
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve({ port: server.address().port, server, pending: () => [...sessions.values()].filter((item) => item.state === 'pending' && Date.now() < item.expiresAt), confirm, reject: (sessionId) => { const item = sessions.get(String(sessionId || '')); if (!item || item.state !== 'pending') return { ok: false, reasonCode: 'SESSION_NOT_FOUND' }; item.state = 'rejected'; return { ok: true, state: item.state, remoteDeviceId: item.fromDeviceId }; } }));
  });
}
module.exports = { startPairingServer };
