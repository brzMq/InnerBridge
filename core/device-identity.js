/* global require, module */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createDeviceId, normalizeDevice } = require('./device-schema');

function fingerprint(publicKey) { return `sha256:${crypto.createHash('sha256').update(publicKey).digest('base64url')}`; }
function ensureIdentityKeys(file, identity = {}) {
  if (identity.publicKey && identity.fingerprint) return identity;
  const keyFile = `${file}.private.pem`;
  let privateKey;
  try { privateKey = fs.readFileSync(keyFile, 'utf8'); } catch {
    const pair = crypto.generateKeyPairSync('ed25519'); privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return { publicKey, fingerprint: fingerprint(publicKey) };
}
function writeAtomic(file, device) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(device, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
function loadOrCreateIdentity(file, details = {}) {
  if (!file) throw new Error('identity file is required');
  let stored = {};
  try { if (fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { stored = {}; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const device = normalizeDevice({ ...stored, ...details, deviceId: stored.deviceId || createDeviceId(), hostname: details.hostname || stored.hostname || os.hostname(), presence: stored.presence || { firstSeenAt: now, lastSeenAt: now, source: 'local' }, identity: ensureIdentityKeys(file, stored.identity) });
  writeAtomic(file, device); return device;
}
module.exports = { loadOrCreateIdentity, fingerprint };
