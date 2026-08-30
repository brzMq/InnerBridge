const dgram = require('dgram');
const { mergeDiscovered, markOffline, publicDevice } = require('../core/discovery');

const DISCOVERY_PORT = 49321;

function minimalAnnouncement(device) {
  return {
    schemaVersion: device.schemaVersion,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    deviceType: device.deviceType,
    platform: device.platform,
    app: device.app,
    identity: { fingerprint: device.identity?.fingerprint || '' },
    services: device.services,
    capabilities: Object.fromEntries(
      Object.entries(device.capabilities || {}).map(([name, value]) => [name, {
        supported: Boolean(value.supported),
        configured: Boolean(value.configured),
        available: Boolean(value.available),
        verified: Boolean(value.verified),
        ...(value.reasonCode ? { reasonCode: String(value.reasonCode) } : {}),
      }])
    ),
  };
}

function startDiscovery(localDevice, { port = DISCOVERY_PORT, onChange } = {}) {
  let currentLocal = localDevice;
  const registry = new Map([[currentLocal.deviceId, currentLocal]]);
  const socket = dgram.createSocket('udp4');

  const announce = () => {
    const packet = Buffer.from(JSON.stringify(minimalAnnouncement(currentLocal)));
    socket.setBroadcast(true);
    const targets = new Set(['255.255.255.255']);
    for (const address of currentLocal.network?.addresses || []) {
      const parts = String(address.address || '').split('.');
      if (parts.length === 4) targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }
    for (const target of targets) socket.send(packet, 0, packet.length, port, target);
  };

  socket.on('message', (buffer, remote) => {
    try {
      const device = JSON.parse(buffer.toString('utf8'));
      if (!device.deviceId || device.deviceId === currentLocal.deviceId) return;
      device.network = { preferredAddress: remote.address };
      mergeDiscovered(registry, device);
      onChange?.([...registry.values()].map(publicDevice));
    } catch {
      // 忽略格式错误或非本协议的 UDP 数据包。
    }
  });
  socket.on('error', () => {});
  socket.bind(port, '0.0.0.0', announce);

  const timer = setInterval(announce, 15000);
  timer.unref?.();
  const offline = setInterval(
    () => onChange?.([...markOffline(registry).values()].map(publicDevice)),
    10000
  );
  offline.unref?.();

  return {
    port,
    list: () => [...markOffline(registry).values()].map(publicDevice),
    refresh: announce,
    updateLocal: (next) => {
      if (!next?.deviceId) return;
      const changed = JSON.stringify(minimalAnnouncement(currentLocal)) !== JSON.stringify(minimalAnnouncement(next));
      if (currentLocal.deviceId !== next.deviceId) registry.delete(currentLocal.deviceId);
      currentLocal = next;
      registry.set(next.deviceId, next);
      if (changed) announce();
    },
    close: () => {
      clearInterval(timer);
      clearInterval(offline);
      socket.close();
    },
  };
}

module.exports = { DISCOVERY_PORT, minimalAnnouncement, startDiscovery };
