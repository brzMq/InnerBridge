const fs = require('fs');
const path = require('path');

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function listFlatFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function sumFiles(files) {
  return files.reduce((sum, file) => sum + (safeStat(file)?.size || 0), 0);
}

function storageStats({ messagesFile, imagesDir, filesDir, messages = [] }) {
  const images = listFlatFiles(imagesDir);
  const files = listFlatFiles(filesDir);
  const historyBytes = safeStat(messagesFile)?.size || 0;
  const imageBytes = sumFiles(images);
  const fileBytes = sumFiles(files);
  return {
    messageCount: messages.length,
    historyBytes,
    imageCount: images.length,
    imageBytes,
    fileCount: files.length,
    fileBytes,
    totalBytes: historyBytes + imageBytes + fileBytes,
  };
}

function referencedNames(messages) {
  const refs = new Set();
  for (const message of messages || []) {
    if (typeof message.image === 'string' && message.image.startsWith('/img/')) refs.add(path.basename(message.image));
    if (message.file?.url && typeof message.file.url === 'string' && message.file.url.startsWith('/file/')) {
      refs.add(path.basename(message.file.url));
    }
  }
  return refs;
}

function removeFiles(files, keep = null) {
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    if (keep?.has(path.basename(file))) continue;
    const size = safeStat(file)?.size || 0;
    try {
      fs.unlinkSync(file);
      count += 1;
      bytes += size;
    } catch { /* 单个缓存被占用时继续清理其余文件 */ }
  }
  return { count, bytes };
}

function assertStorageLayout(messagesFile, imagesDir, filesDir) {
  const root = path.resolve(path.dirname(messagesFile));
  for (const target of [imagesDir, filesDir]) {
    if (path.dirname(path.resolve(target)) !== root) throw new Error('拒绝清理数据目录之外的路径');
  }
}

function clearChatStorage({ scope, messagesFile, imagesDir, filesDir, messages }) {
  if (!['messages', 'orphaned', 'all'].includes(scope)) throw new Error('无效的清理范围');
  assertStorageLayout(messagesFile, imagesDir, filesDir);
  const result = { scope, removedFiles: 0, removedBytes: 0 };

  if (scope === 'messages' || scope === 'all') {
    const size = safeStat(messagesFile)?.size || 0;
    fs.mkdirSync(path.dirname(messagesFile), { recursive: true });
    fs.writeFileSync(messagesFile, '', 'utf-8');
    messages.splice(0, messages.length);
    result.removedBytes += size;
  }

  const keep = scope === 'orphaned' ? referencedNames(messages) : null;
  if (scope === 'orphaned' || scope === 'all') {
    for (const dir of [imagesDir, filesDir]) {
      const removed = removeFiles(listFlatFiles(dir), keep);
      result.removedFiles += removed.count;
      result.removedBytes += removed.bytes;
    }
  }

  return { ...result, stats: storageStats({ messagesFile, imagesDir, filesDir, messages }) };
}

module.exports = { storageStats, clearChatStorage, referencedNames };
