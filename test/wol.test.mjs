import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, normalizeMac, buildMagicPacket, broadcastAddress, wolState } from '../core/wol.js';

test('MAC 归一化', () => {
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aabb.ccddeeff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('12:34:56'), '');
  assert.equal(normalizeMac(''), '');
});

test('魔术包：6 字节 FF + MAC 重复 16 次', () => {
  const packet = buildMagicPacket('f0:18:98:aa:bb:cc');
  assert.equal(packet.length, 102);
  for (let i = 0; i < 6; i++) assert.equal(packet[i], 0xff);
  assert.equal(packet.slice(6, 12).toString('hex'), 'f01898aabbcc');
  assert.equal(packet.slice(96, 102).toString('hex'), 'f01898aabbcc');
  assert.throws(() => buildMagicPacket('bad'), /MAC/);
});

test('广播地址计算', () => {
  assert.equal(broadcastAddress('192.168.31.20', 24), '192.168.31.255');
  assert.equal(broadcastAddress('10.0.5.7', 16), '10.0.255.255');
  assert.equal(broadcastAddress('10.0.5.7', 8), '10.255.255.255');
  assert.equal(broadcastAddress('10.0.5.7'), '10.0.5.255');
  assert.equal(broadcastAddress('bad-ip', 24), '');
  assert.equal(broadcastAddress('1.2.3.4', 40), '');
});

test('WOL 状态机：未配置/已配置/已验证', () => {
  assert.equal(wolState(null).state, STATES.NOT_CONFIGURED);
  assert.equal(wolState({ targetMac: '' }).state, STATES.NOT_CONFIGURED);
  assert.equal(wolState({ targetMac: 'f0:18:98:aa:bb:cc' }).state, STATES.NOT_CONFIGURED);
  assert.equal(wolState({ targetMac: 'f0:18:98:aa:bb:cc', broadcastAddresses: ['192.168.31.255'] }).state, STATES.CONFIGURED);
  assert.equal(wolState({ targetMac: 'f0:18:98:aa:bb:cc', broadcastAddresses: ['192.168.31.255'], verified: true }).state, STATES.VERIFIED);
});
