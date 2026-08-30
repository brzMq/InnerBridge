import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMac, vendorOf, isMulticastMac, parseArpTable, mergeLanDevices } from '../core/lan-devices.js';

test('MAC 归一化：支持冒号/横杠/省略分隔，拒绝广播与非法输入', () => {
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('ff:ff:ff:ff:ff:ff'), '');
  assert.equal(normalizeMac('incomplete'), '');
  assert.equal(normalizeMac(null), '');
});

test('厂商推断与组播过滤', () => {
  assert.equal(vendorOf('f0:18:98:12:34:56'), 'Apple');
  assert.equal(vendorOf('64-70-05-aa-bb-cc'), 'Xiaomi');
  assert.equal(vendorOf('01:00:5e:00:00:01'), '');
  assert.equal(vendorOf('de:ad:be:ef:00:01'), '');
  assert.equal(isMulticastMac('ff:ff:ff:ff:ff:ff'), true);
  assert.equal(isMulticastMac('01:00:5e:00:00:01'), true);
  assert.equal(isMulticastMac('f0:18:98:12:34:56'), false);
  assert.equal(isMulticastMac('garbage'), true);
});

test('解析 macOS arp -a 输出', () => {
  const text = [
    '? (192.168.31.1) at 50:c2:e8:11:22:33 on en0 ifscope [ethernet]',
    '? (192.168.31.20) at f0:18:98:aa:bb:cc on en0 ifscope [ethernet]',
    '? (192.168.31.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]',
    '? (224.0.0.251) at 1:0:5e:0:0:fb on en0 permanent [ethernet]',
    '? (192.168.31.30) at (incomplete) on en0 ifscope [ethernet]',
  ].join('\n');
  const list = parseArpTable(text);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((d) => d.ip), ['192.168.31.1', '192.168.31.20']);
  assert.equal(list[0].vendor, 'TP-Link');
  assert.equal(list[1].vendor, 'Apple');
});

test('解析 Windows arp -a 输出（横杠 MAC、动态类型）', () => {
  const text = [
    '',
    '接口: 192.168.31.5 --- 0x5',
    '  Internet 地址         物理地址              类型',
    '  192.168.31.1          50-c2-e8-11-22-33     动态',
    '  192.168.31.20         f0-18-98-aa-bb-cc     动态',
    '  192.168.31.255        ff-ff-ff-ff-ff-ff     静态',
    '  224.0.0.22            01-00-5e-00-00-16     静态',
  ].join('\n');
  const list = parseArpTable(text);
  assert.equal(list.length, 2);
  assert.equal(list[1].mac, 'f0:18:98:aa:bb:cc');
});

test('合并与过期：同 IP 更新 lastSeenAt，超 TTL 丢弃', () => {
  const now = Date.now();
  const first = mergeLanDevices([], [{ ip: '192.168.31.20', mac: 'f0:18:98:aa:bb:cc', vendor: 'Apple', firstSeenAt: 'x' }], now);
  assert.equal(first.length, 1);
  assert.equal(first[0].firstSeenAt, 'x');
  const second = mergeLanDevices(first, [{ ip: '192.168.31.20', mac: 'f0:18:98:aa:bb:cc', vendor: 'Apple' }], now + 1000);
  assert.equal(second[0].firstSeenAt, 'x'); // 首见时间保留
  assert.equal(second.length, 1);
  const expired = mergeLanDevices(first, [], now + 10 * 60 * 1000 + 1);
  assert.equal(expired.length, 0);
});
