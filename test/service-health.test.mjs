import test from 'node:test'; import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const h = require('../core/service-health');
test('服务端口配置固定默认值并安全规范化', () => { assert.deepEqual(h.normalizeServicePorts({ chat: 6300, pairing: '7891', transfer: 0 }), { discovery: 49321, chat: 6300, pairing: 7891, sync: 7892, transfer: 49152 }); assert.equal(h.describePort('chat', 7890, true, true).state, 'healthy'); assert.equal(h.describePort('chat', 7890, true, false).state, 'occupied'); });
