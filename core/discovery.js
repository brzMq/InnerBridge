/* global module */
const DEFAULT_OFFLINE_MS = 45000;
function mergeDiscovered(registry, incoming, now = Date.now(), offlineMs = DEFAULT_OFFLINE_MS) {
  if (!incoming?.deviceId) return registry;
  const previous = registry.get(incoming.deviceId);
  const sameIdentity = !previous?.identity?.fingerprint || !incoming.identity?.fingerprint || previous.identity.fingerprint === incoming.identity.fingerprint;
  registry.set(incoming.deviceId, { ...(previous || {}), ...incoming, presence: { ...(previous?.presence || {}), ...(incoming.presence || {}), online: true, lastSeenAt: new Date(now).toISOString() }, trust: sameIdentity ? (previous?.trust || incoming.trust || { state: 'unpaired' }) : { ...(previous?.trust || {}), state: 'identity_changed' } });
  return markOffline(registry, now, offlineMs);
}
function markOffline(registry, now = Date.now(), offlineMs = DEFAULT_OFFLINE_MS) {
  for (const [id, device] of registry) { const seen = Date.parse(device.presence?.lastSeenAt || 0); if (seen && now - seen > offlineMs) registry.set(id, { ...device, presence: { ...device.presence, online: false } }); }
  return registry;
}
function publicDevice(device) { return { schemaVersion: device.schemaVersion, deviceId: device.deviceId, deviceName: device.deviceName, hostname: device.hostname, platform: device.platform, platformVersion: device.platformVersion, deviceType: device.deviceType, app: device.app, identity: { fingerprint: device.identity?.fingerprint || '' }, network: { preferredAddress: device.network?.preferredAddress || '' }, presence: { online: Boolean(device.presence?.online), lastSeenAt: device.presence?.lastSeenAt || null, source: device.presence?.source || 'local' }, capabilities: device.capabilities, services: device.services }; }
module.exports = { DEFAULT_OFFLINE_MS, mergeDiscovered, markOffline, publicDevice };
