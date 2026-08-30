/* global module, Buffer */
// Wake-on-LAN 纯函数：MAC 校验/归一化、魔术包构造、广播地址计算、状态机。
// 设计文档 §10：软件只能诚实区分「检测结果」与「用户确认」，未配置不显示为可唤醒。

const STATES = { UNSUPPORTED: 'unsupported', NOT_CONFIGURED: 'not_configured', CONFIGURED: 'configured', VERIFIED: 'verified' };

function normalizeMac(raw) {
  const hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return '';
  return hex.replace(/(..)(..)(..)(..)(..)(..)/, '$1:$2:$3:$4:$5:$6');
}

// 构造魔术包：6 字节 0xFF + 目标 MAC 重复 16 次
function buildMagicPacket(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new Error('MAC 地址无效');
  const bytes = normalized.split(':').map((h) => parseInt(h, 16));
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) packet.writeUInt8(bytes[j], 6 + i * 6 + j);
  }
  return packet;
}

// 由 IPv4 与前缀长度计算子网广播地址（如 192.168.31.20/24 → 192.168.31.255）
function broadcastAddress(ip, prefixLength = 24) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return '';
  const prefix = Number(prefixLength) || 24;
  if (!(prefix >= 0 && prefix <= 32)) return '';
  const ipInt = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const broadcast = (ipInt | (~mask >>> 0)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 0xff).join('.');
}

// WOL 目标配置的完整状态：能力是否可执行由这里唯一决定
function wolState(config) {
  const c = config || {};
  if (!normalizeMac(c.targetMac)) return { state: STATES.NOT_CONFIGURED, reasonCode: 'NOT_CONFIGURED' };
  const broadcasts = (c.broadcastAddresses || []).filter(Boolean);
  if (!broadcasts.length) return { state: STATES.NOT_CONFIGURED, reasonCode: 'NO_BROADCAST' };
  if (c.verified) return { state: STATES.VERIFIED };
  return { state: STATES.CONFIGURED };
}

module.exports = { STATES, normalizeMac, buildMagicPacket, broadcastAddress, wolState };
