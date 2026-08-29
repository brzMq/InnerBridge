/* global require, module, process, Buffer */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 由主进程注入 Electron safeStorage；无注入时使用本机密钥派生的 AES-GCM 文件格式。
function createCredentialStore(file, { safeStorage, machineKey = `${process.platform}:${process.arch}` } = {}) {
  const key = crypto.createHash('sha256').update(machineKey).digest();
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const encode = (value) => {
    if (safeStorage?.isEncryptionAvailable?.()) return { mode: 'safeStorage', value: safeStorage.encryptString(value).toString('base64') };
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { mode: 'aes-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: data.toString('base64') };
  };
  const decode = (record) => { if (record?.mode === 'safeStorage') return safeStorage.decryptString(Buffer.from(record.value, 'base64')); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64')); decipher.setAuthTag(Buffer.from(record.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(record.value, 'base64')), decipher.final()]).toString('utf8'); };
  return {
    set(deviceId, credential) { const data = read(); data[deviceId] = encode(String(credential)); fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); },
    get(deviceId) { const record = read()[deviceId]; return record ? decode(record) : null; },
    remove(deviceId) { const data = read(); delete data[deviceId]; fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); },
  };
}
module.exports = { createCredentialStore };
