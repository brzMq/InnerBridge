const dgram = require('dgram');
const http = require('http');
const { buildMagicPacket, wolState } = require('../core/wol');

// 发送魔术包：向每个广播地址连发 times 次（默认 3 次容错）
function sendMagicPacket(packet, broadcastAddresses, { port = 9, times = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let sent = 0;
    let failed = 0;
    const targets = (broadcastAddresses || []).filter(Boolean);
    if (!targets.length) return reject(new Error('没有可用的广播地址'));
    socket.on('error', () => { /* 广播地址不可达等错误按失败计数，不中断 */ });
    socket.bind(() => {
      socket.setBroadcast(true);
      let pending = targets.length;
      for (const target of targets) {
        let count = 0;
        const sendOne = () => {
          socket.send(packet, 0, packet.length, port, target, () => {
            sent += 1;
            count += 1;
            if (count < times) setTimeout(sendOne, 200);
            else if ((pending -= 1) === 0) socket.close(() => resolve({ sent, failed }));
          });
        };
        sendOne();
      }
    });
  });
}

// 探测对端 InnerBridge 是否已上线（聊天服务是所有实例必开的服务）
function probeOnline(address, port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const request = http.get({ host: address, port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

// 唤醒编排：发包 → 轮询探测（关机到网卡上电再到系统起来通常要几十秒）
async function wake({ targetMac, broadcastAddresses, address, port }, { probeMs = 45000, intervalMs = 3000 } = {}) {
  const state = wolState({ targetMac, broadcastAddresses });
  if (state.state === 'not_configured') throw new Error(state.reasonCode === 'NO_BROADCAST' ? '缺少广播地址配置' : '尚未配置目标 MAC');
  const packet = buildMagicPacket(targetMac);
  const sendResult = await sendMagicPacket(packet, broadcastAddresses);
  const deadline = Date.now() + probeMs;
  let online = false;
  while (Date.now() < deadline) {
    online = await probeOnline(address, port);
    if (online) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { sent: sendResult.sent, online };
}

module.exports = { sendMagicPacket, probeOnline, wake };
