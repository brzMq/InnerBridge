/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const schema = require('../core/device-schema');
const { resolveCapabilities, buildLocalDevice } = require('../core/capability-resolver');
const { mergeDiscovered, markOffline } = require('../core/discovery');
const { minimalAnnouncement } = require('../electron/discovery-service');

test('Device Schema 标准化并校验稳定 deviceId', () => {
  const id = schema.createDeviceId(Buffer.alloc(16, 1));
  const d = schema.normalizeDevice({ deviceId: id, platform: 'darwin', deviceName: 'Mac' });
  assert.equal(d.deviceId, id); assert.equal(d.schemaVersion, 1); assert.equal(schema.validateDevice(d).valid, true);
});

test('旧资料迁移补齐能力字段且不改变 deviceId', () => {
  const d = schema.migrateDevice({ deviceId: `dev_${'a'.repeat(32)}`, platform: 'win32', hostname: 'PC' });
  assert.equal(d.deviceName, 'PC'); assert.equal(d.capabilities.smbShare.supported, false); assert.equal(d.deviceId, `dev_${'a'.repeat(32)}`);
});

test('能力解析区分平台支持、服务状态和信任状态', () => {
  const caps = resolveCapabilities({ platform: 'win32', trusted: false, services: { chat: true, smbShare: false } });
  assert.equal(caps.smbShare.supported, true); assert.equal(caps.smbShare.available, false); assert.equal(caps.smbShare.reasonCode, 'SERVICE_UNAVAILABLE');
  assert.equal(caps.smbMount.supported, false); assert.equal(caps.smbMount.reasonCode, 'PLATFORM_NOT_SUPPORTED');
});

test('本机设备构建使用能力解析器而非页面拼接', () => {
  const d = buildLocalDevice({ platform: 'darwin', trusted: true, config: { smbMount: true } });
  assert.equal(d.capabilities.smbMount.supported, true); assert.equal(d.capabilities.smbMount.available, true);
});

test('设备注册表处理 IP 更新、离线和身份冲突', () => {
  const registry = new Map();
  mergeDiscovered(registry, { deviceId: 'dev_' + 'b'.repeat(32), identity: { fingerprint: 'a' }, network: { preferredAddress: '192.168.1.2' }, presence: {} }, 1000);
  mergeDiscovered(registry, { deviceId: 'dev_' + 'b'.repeat(32), identity: { fingerprint: 'a' }, network: { preferredAddress: '192.168.1.3' }, presence: {} }, 2000);
  assert.equal(registry.get('dev_' + 'b'.repeat(32)).network.preferredAddress, '192.168.1.3');
  mergeDiscovered(registry, { deviceId: 'dev_' + 'b'.repeat(32), identity: { fingerprint: 'changed' }, presence: {} }, 3000);
  assert.equal(registry.get('dev_' + 'b'.repeat(32)).trust.state, 'identity_changed');
  markOffline(registry, 60000, 45000); assert.equal(registry.get('dev_' + 'b'.repeat(32)).presence.online, false);
});

test('发现公告只包含最小公开字段，不包含网络身份敏感资料', () => {
  const p = minimalAnnouncement({ schemaVersion: 1, deviceId: 'dev_' + 'c'.repeat(32), deviceName: '测试', deviceType: 'desktop', platform: 'darwin', app: { version: '2.0.0' }, services: { chat: { port: 7890 } }, capabilities: { chat: { supported: true, configured: true, available: true }, smbMount: { supported: true, configured: true, available: true } }, identity: { fingerprint: 'secret' }, network: { preferredAddress: '10.0.0.1' } });
  assert.equal(p.identity.fingerprint, 'secret'); assert.equal(p.identity.publicKey, undefined); assert.equal(p.network, undefined); assert.equal(p.capabilities.chat.available, undefined); assert.equal(p.capabilities.chat.supported, true);
});
