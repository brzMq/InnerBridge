const fs = require('fs');
async function sendFile({ file, manifest, endpoint, token, onProgress } = {}) {
  if (!file || !manifest?.transferId || !endpoint || !token) throw new Error('传输参数无效');
  const stat = fs.statSync(file); if (stat.size !== manifest.size) throw new Error('文件大小与清单不一致');
  let sent = 0;
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const start = index * manifest.chunkSize; const size = Math.min(manifest.chunkSize, manifest.size - start); const stream = fs.createReadStream(file, { start, end: start + size - 1 });
    const response = await globalThis.fetch(`${endpoint.replace(/\/$/, '')}/transfer/${encodeURIComponent(manifest.transferId)}/chunk`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Chunk-Index': String(index), 'Content-Length': String(size) }, body: stream, duplex: 'half' });
    if (!response.ok) throw new Error(`传输分块失败 (${response.status})`);
    sent += size; onProgress?.({ index, sent, total: manifest.size, percent: manifest.size ? sent / manifest.size : 1 });
  }
  return { ok: true, sent, total: manifest.size };
}
module.exports = { sendFile };
