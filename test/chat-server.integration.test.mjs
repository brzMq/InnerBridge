import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import chatServer from '../electron/chat-server.js';

const { startChatServer } = chatServer;
let info;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-net-chat-test-'));
  info = await startChatServer(0, {
    host: '127.0.0.1',
    file: path.join(tempDir, 'messages.jsonl'),
    imagesDir: path.join(tempDir, 'images'),
    filesDir: path.join(tempDir, 'files'),
  });
});

after(async () => {
  if (info && info.server) await new Promise((resolve) => info.server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function postMessage(body) {
  const response = await fetch(`${info.url}/api/msg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('消息接口支持幂等发送、可信回复快照和搜索', async () => {
  const firstBody = {
    clientId: 'client_msg_0001',
    requesterId: 'dev_chat_tester_00000000000000000000000',
    nick: 'Alice',
    text: '部署完成',
  };
  const first = await postMessage(firstBody);
  assert.equal(first.response.status, 200);
  assert.equal(first.data.msg.id, 1);

  const duplicate = await postMessage(firstBody);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.msg.id, 1);
  assert.equal(info.messages.length, 1);

  const reply = await postMessage({
    clientId: 'client_msg_0002',
    requesterId: 'dev_chat_tester_00000000000000000000000',
    nick: 'Bob',
    text: '收到',
    replyTo: { id: 1, nick: '不能信任的昵称' },
  });
  assert.deepEqual(reply.data.msg.reply, { id: 1, nick: 'Alice', text: '部署完成' });

  const search = await fetch(`${info.url}/api/msg?q=${encodeURIComponent('收到')}&limit=10`).then((r) => r.json());
  assert.deepEqual(search.messages.map((message) => message.id), [2]);
});

test('压缩文件上传保留类型、名称和大小元数据', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const uploadResponse = await fetch(`${info.url}/api/upload?name=${encodeURIComponent('项目资料.zip')}&requesterId=dev_chat_tester_00000000000000000000000`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: bytes,
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200);
  assert.equal(upload.kind, 'archive');
  assert.equal(upload.name, '项目资料.zip');
  assert.equal(upload.size, bytes.length);

  const sent = await postMessage({
    clientId: 'client_archive_0001',
    requesterId: 'dev_chat_tester_00000000000000000000000',
    nick: 'Alice',
    text: '',
    file: { url: upload.url, name: upload.name, kind: upload.kind, size: upload.size },
  });
  assert.deepEqual(sent.data.msg.file, {
    url: upload.url,
    name: '项目资料.zip',
    kind: 'archive',
    size: bytes.length,
  });
});

test('手机页面使用本地 JSZip，并为消息和上传携带稳定设备身份', async () => {
  const html = await fetch(`${info.url}/`).then((r) => r.text());
  assert.match(html, /inner-net-web-device-id/);
  assert.match(html, /requesterId:\s*requesterId/);
  assert.match(html, /requesterId=' \+ encodeURIComponent\(requesterId\)/);
  const response = await fetch(`${info.url}/vendor/jszip.min.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /JSZip/);
});
