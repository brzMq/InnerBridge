import test from 'node:test'; import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const { startPairingServer } = require('../electron/security/pairing-service');
const local = 'dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; const remote = 'dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
test('配对服务双端展示验证码，但只允许接收端本机确认', async () => {
  let notified; const service = await startPairingServer({ port: 0, deviceId: local, onRequest: (item) => { notified = item; } });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/api/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDeviceId: remote, fromDeviceName: '远端', fromFingerprint: 'sha256:remote', toDeviceId: local }) });
    const requested = await response.json(); assert.equal(response.status, 200); assert.equal(notified.code, requested.code); assert.equal(service.pending()[0].code, requested.code);
    const status = await (await fetch(`http://127.0.0.1:${service.port}/api/pair/status/${requested.sessionId}`)).json(); assert.equal(status.code, undefined); assert.equal(status.state, 'pending');
    assert.equal(service.confirm(requested.sessionId, '000000').reasonCode, 'CODE_MISMATCH'); assert.equal(service.confirm(requested.sessionId, requested.code).ok, true);
    const accepted = await (await fetch(`http://127.0.0.1:${service.port}/api/pair/status/${requested.sessionId}`)).json(); assert.equal(accepted.state, 'accepted'); assert.ok(accepted.authorization?.authorizationId);
    const remoteConfirm = await fetch(`http://127.0.0.1:${service.port}/api/pair/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: requested.sessionId, code: requested.code }) }); assert.equal(remoteConfirm.status, 404);
    const second = await fetch(`http://127.0.0.1:${service.port}/api/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDeviceId: remote, toDeviceId: local }) }).then((r) => r.json());
    assert.equal(service.reject(second.sessionId).ok, true);
  } finally { await new Promise((resolve) => service.server.close(resolve)); }
});
