const dgram = require('dgram');
const { mergeDiscovered, markOffline, publicDevice } = require('../core/discovery');

const DISCOVERY_PORT = 49321;
function minimalAnnouncement(device) {
  return { schemaVersion: device.schemaVersion, deviceId: device.deviceId, deviceName: device.deviceName, deviceType: device.deviceType, platform: device.platform, app: device.app, identity: { fingerprint: device.identity?.fingerprint || '' }, services: device.services, capabilities: Object.fromEntries(Object.entries(device.capabilities || {}).map(([k, v]) => [k, { supported: Boolean(v.supported), configured: Boolean(v.configured) }])) };
}
function startDiscovery(localDevice, { port = DISCOVERY_PORT, onChange } = {}) {
  const registry = new Map([[localDevice.deviceId, localDevice]]); const socket = dgram.createSocket('udp4');
  const announce = () => { const packet = Buffer.from(JSON.stringify(minimalAnnouncement(localDevice))); socket.setBroadcast(true); const targets = new Set(['255.255.255.255']); for (const a of localDevice.network?.addresses || []) { const parts = String(a.address || '').split('.'); if (parts.length === 4) targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`); } for (const target of targets) socket.send(packet, 0, packet.length, port, target); };
  socket.on('message', (buf, rinfo) => { try { const d = JSON.parse(buf.toString('utf8')); if (!d.deviceId || d.deviceId === localDevice.deviceId) return; d.network = { preferredAddress: rinfo.address }; mergeDiscovered(registry, d); onChange?.([...registry.values()].map(publicDevice)); } catch { /* ignore malformed packets */ } });
  socket.on('error', () => {}); socket.bind(port, '0.0.0.0', announce);
  const timer = setInterval(announce, 15000); timer.unref?.(); const offline = setInterval(() => onChange?.([...markOffline(registry).values()].map(publicDevice)), 10000); offline.unref?.();
  return { list: () => [...markOffline(registry).values()].map(publicDevice), refresh: announce, close: () => { clearInterval(timer); clearInterval(offline); socket.close(); } };
}
module.exports = { DISCOVERY_PORT, minimalAnnouncement, startDiscovery };
