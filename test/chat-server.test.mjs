import { test } from 'node:test';
import assert from 'node:assert/strict';
import chat from '../electron/chat-server.js';

const { trimLines } = chat;

test('trimLines 未超上限时返回原数组（引用不变）', () => {
  const lines = ['a', 'b', 'c'];
  const out = trimLines(lines, 5);
  assert.equal(out, lines);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('trimLines 等于上限时不裁剪', () => {
  const lines = ['1', '2', '3'];
  assert.deepEqual(trimLines(lines, 3), ['1', '2', '3']);
});

test('trimLines 超过上限时保留最近 max 条', () => {
  const lines = ['1', '2', '3', '4', '5'];
  assert.deepEqual(trimLines(lines, 3), ['3', '4', '5']);
});

test('trimLines 入参非数组时安全返回', () => {
  assert.deepEqual(trimLines(null, 3), null);
  assert.deepEqual(trimLines(undefined, 3), undefined);
  assert.deepEqual(trimLines([], 3), []);
});
