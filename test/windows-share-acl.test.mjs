import assert from 'node:assert/strict';
import { test } from 'node:test';
import acl from '../electron/windows-share-acl.js';

const { hasFullAllowAccess, normalizeWindowsPrincipal, parseAccessJson } = acl;

test('裸用户名自动补 Windows 机器名前缀', () => {
  assert.equal(normalizeWindowsPrincipal('brz', 'BRZ'), 'BRZ\\brz');
});

test('完整域账号保持不变', () => {
  assert.equal(normalizeWindowsPrincipal('DOMAIN\\user', 'BRZ'), 'DOMAIN\\user');
});

test('拒绝空用户名坏 principal', () => {
  assert.throws(() => normalizeWindowsPrincipal('BRZ\\', 'BRZ'), /格式无效/);
});

test('只接受目标账号的 Full Allow ACE', () => {
  const entries = [
    { accountName: 'BRZ\\', isFull: true, isAllow: true },
    { accountName: 'BRZ\\brz', isFull: false, isAllow: true },
  ];
  assert.equal(hasFullAllowAccess(entries, 'BRZ\\brz'), false);
  entries.push({ accountName: 'OTHER\\brz', isFull: true, isAllow: true });
  assert.equal(hasFullAllowAccess(entries, 'BRZ\\brz'), false);
  entries.push({ accountName: 'BRZ\\other', isFull: true, isAllow: true });
  assert.equal(hasFullAllowAccess(entries, 'BRZ\\brz'), false);
  entries.push({ accountName: 'brz\\brz', isFull: true, isAllow: true });
  assert.equal(hasFullAllowAccess(entries, 'BRZ\\brz'), true);
});

test('PowerShell 单对象/数组 JSON 都标准化为数组', () => {
  assert.deepEqual(parseAccessJson('{"accountName":"BRZ\\\\brz","isFull":true,"isAllow":true}').length, 1);
  assert.deepEqual(parseAccessJson('[]'), []);
});
