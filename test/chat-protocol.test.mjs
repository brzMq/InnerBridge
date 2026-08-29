import assert from 'node:assert/strict';
import { test } from 'node:test';
import protocol from '../electron/chat-protocol.js';

const { messagePreview, normalizeClientId, resolveReply, selectMessages } = protocol;

const messages = [
  { id: 1, nick: 'Alice', text: '部署完成', ts: 1 },
  { id: 2, nick: 'Bob', text: '', image: '/img/a.png', ts: 2 },
  { id: 3, nick: 'Alice', text: '查看日志', file: { name: 'run.log' }, ts: 3 },
];

test('客户端消息 ID 只接受有限安全字符', () => {
  assert.equal(normalizeClientId('abcDEF_123-xyz'), 'abcDEF_123-xyz');
  assert.equal(normalizeClientId('短'), null);
  assert.equal(normalizeClientId('../bad-client-id'), null);
});

test('回复内容由服务端已有消息生成，不信任客户端快照', () => {
  assert.deepEqual(resolveReply({ id: 2, nick: '伪造' }, messages), {
    id: 2,
    nick: 'Bob',
    text: '[图片]',
  });
  assert.equal(resolveReply({ id: 99 }, messages), null);
});

test('历史查询支持 since、关键词和最大 200 条边界', () => {
  assert.deepEqual(selectMessages(messages, { since: 1 }).map((m) => m.id), [2, 3]);
  assert.deepEqual(selectMessages(messages, { q: 'LOG' }).map((m) => m.id), [3]);
  const many = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, nick: 'n', text: 'x' }));
  assert.equal(selectMessages(many, { limit: 999 }).length, 200);
});

test('消息预览兼容文本、图片和文件', () => {
  assert.equal(messagePreview(messages[0]), '部署完成');
  assert.equal(messagePreview(messages[1]), '[图片]');
  assert.equal(messagePreview({ file: { name: 'a.txt' } }), '[文件] a.txt');
});
