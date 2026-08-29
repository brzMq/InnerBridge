import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import storageModule from '../electron/chat-storage.js';

const { clearChatStorage, storageStats } = storageModule;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-net-storage-'));
  const messagesFile = path.join(root, 'messages.jsonl');
  const imagesDir = path.join(root, 'images');
  const filesDir = path.join(root, 'files');
  fs.mkdirSync(imagesDir);
  fs.mkdirSync(filesDir);
  fs.writeFileSync(messagesFile, '{"id":1}\n');
  fs.writeFileSync(path.join(imagesDir, 'keep.png'), 'image');
  fs.writeFileSync(path.join(imagesDir, 'orphan.png'), 'unused');
  fs.writeFileSync(path.join(filesDir, 'keep.zip'), 'archive');
  const messages = [{ id: 1, image: '/img/keep.png', file: { url: '/file/keep.zip' } }];
  return { root, messagesFile, imagesDir, filesDir, messages };
}

test('缓存统计并仅清理未引用文件', () => {
  const data = fixture();
  try {
    const before = storageStats(data);
    assert.equal(before.messageCount, 1);
    assert.equal(before.imageCount, 2);
    assert.equal(before.fileCount, 1);
    const result = clearChatStorage({ ...data, scope: 'orphaned' });
    assert.equal(result.removedFiles, 1);
    assert.equal(fs.existsSync(path.join(data.imagesDir, 'keep.png')), true);
    assert.equal(fs.existsSync(path.join(data.filesDir, 'keep.zip')), true);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test('全部清空会同步清空内存消息、历史和附件缓存', () => {
  const data = fixture();
  try {
    const result = clearChatStorage({ ...data, scope: 'all' });
    assert.equal(data.messages.length, 0);
    assert.equal(fs.readFileSync(data.messagesFile, 'utf-8'), '');
    assert.equal(result.stats.totalBytes, 0);
    assert.equal(result.removedFiles, 3);
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});
