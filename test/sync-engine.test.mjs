import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../core/sync-engine.js');
const {
  TRASH_DIR, DEFAULT_TRASH_RETENTION_DAYS, backoffMs, buildIgnoreMatcher, carryFailures, chunkPlan, computePlan, extrasOnSlave,
  isInternalPath, normalizeRelPath, parseTrashStamp, purgeStamps, scanTree, toIndex, trashDestination, trashStamp,
} = engine;

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-sync-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('normalizeRelPath 统一分隔符并去掉前导斜杠', () => {
  assert.equal(normalizeRelPath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(normalizeRelPath('a/b/c.txt'), 'a/b/c.txt');
  assert.equal(normalizeRelPath('/a//b/'), 'a/b/');
  assert.equal(normalizeRelPath(''), '');
  assert.equal(normalizeRelPath(null), '');
});

test('isInternalPath 排除回收区与暂存区，避免自我同步', () => {
  assert.equal(isInternalPath(TRASH_DIR), true);
  assert.equal(isInternalPath(`${TRASH_DIR}/20260830-101500/a.txt`), true);
  assert.equal(isInternalPath('.innernet-incoming/x.part'), true);
  assert.equal(isInternalPath('a/b.txt'), false);
  assert.equal(isInternalPath('.innernet-trash-like/a.txt'), false);
});

test('scanTree 递归扫描并跳过内部目录', () => {
  const root = tmpTree({
    'a.txt': 'A',
    'sub/b.txt': 'BB',
    'sub/deep/c.txt': 'CCC',
    [`${TRASH_DIR}/20260830-101500/old.txt`]: 'gone',
  });
  const found = scanTree(root);
  assert.deepEqual([...found.keys()].sort(), ['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);
  assert.equal(found.get('a.txt').size, 1);
  assert.equal(found.get('sub/b.txt').size, 2);
  assert.equal(typeof found.get('a.txt').mtimeMs, 'number');
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanTree 对不存在的目录返回空而不是抛错', () => {
  assert.equal(scanTree(path.join(os.tmpdir(), 'innernet-no-such-dir-xyz')).size, 0);
});

test('computePlan 识别新增、修改与删除', () => {
  const current = new Map([
    ['same.txt', { size: 1, mtimeMs: 100 }],
    ['changed.txt', { size: 9, mtimeMs: 200 }],
    ['new.txt', { size: 3, mtimeMs: 300 }],
  ]);
  const index = {
    'same.txt': { size: 1, mtimeMs: 100 },
    'changed.txt': { size: 5, mtimeMs: 150 },
    'gone.txt': { size: 7, mtimeMs: 170 },
  };
  const plan = computePlan(current, index);
  assert.deepEqual(plan.toPush, ['changed.txt', 'new.txt']);
  assert.deepEqual(plan.toTrash, ['gone.txt']);
});

test('computePlan 空索引时全部视为新增', () => {
  const current = new Map([['a.txt', { size: 1, mtimeMs: 1 }]]);
  assert.deepEqual(computePlan(current, {}).toPush, ['a.txt']);
  assert.deepEqual(computePlan(current, {}).toTrash, []);
});

test('computePlan 索引为空 Map 时不误删', () => {
  assert.deepEqual(computePlan(new Map(), { 'a.txt': { size: 1, mtimeMs: 1 } }).toTrash, ['a.txt']);
});

test('extrasOnSlave 找出从端多余的文件（主从单向）', () => {
  const current = new Map([['a.txt', {}], ['sub/b.txt', {}]]);
  assert.deepEqual(extrasOnSlave(current, ['a.txt', 'sub\\b.txt', 'stray.txt', 'sub/stray2.txt']), ['stray.txt', 'sub/stray2.txt']);
  assert.deepEqual(extrasOnSlave(current, []), []);
  assert.deepEqual(extrasOnSlave(current), []);
});

test('toIndex 落盘为普通对象且只保留 size/mtimeMs', () => {
  const current = new Map([['a.txt', { size: 1, mtimeMs: 2, extra: 'x' }]]);
  assert.deepEqual(toIndex(current), { 'a.txt': { size: 1, mtimeMs: 2 } });
});

test('trashStamp / parseTrashStamp 可往返', () => {
  const now = new Date(2026, 7, 30, 10, 15, 0).getTime();
  const stamp = trashStamp(now);
  assert.match(stamp, /^\d{8}-\d{6}$/);
  assert.equal(parseTrashStamp(stamp), now);
});

test('parseTrashStamp 拒绝非法目录名', () => {
  assert.equal(parseTrashStamp('not-a-stamp'), null);
  assert.equal(parseTrashStamp('20260830'), null);
  assert.equal(parseTrashStamp(''), null);
  assert.equal(parseTrashStamp(null), null);
});

test('trashDestination 保留原路径结构且带时间戳', () => {
  const now = new Date(2026, 7, 30, 10, 15, 0).getTime();
  assert.equal(trashDestination('sub/a.txt', now), `${TRASH_DIR}/20260830-101500/sub/a.txt`);
  assert.equal(trashDestination('sub\\a.txt', now), `${TRASH_DIR}/20260830-101500/sub/a.txt`);
});

test('purgeStamps 只清理超过保留期的批次', () => {
  const now = new Date(2026, 7, 30).getTime();
  const old = '20260701-000000'; // 60 天前
  const recent = '20260829-000000'; // 1 天前
  assert.deepEqual(purgeStamps([old, recent], DEFAULT_TRASH_RETENTION_DAYS, now), [old]);
  assert.deepEqual(purgeStamps([recent], DEFAULT_TRASH_RETENTION_DAYS, now), []);
  // 非法目录名不会被误删
  assert.deepEqual(purgeStamps(['README', old], DEFAULT_TRASH_RETENTION_DAYS, now), [old]);
  // 保留期为 0 时全部清理
  assert.deepEqual(purgeStamps([old, recent], 0, now), [old, recent]);
});

test('purgeStamps 非法保留期回落到默认值', () => {
  const now = new Date(2026, 7, 30).getTime();
  assert.deepEqual(purgeStamps(['20260701-000000'], -5, now), ['20260701-000000']);
  assert.deepEqual(purgeStamps(['20260701-000000'], NaN, now), ['20260701-000000']);
});

test('chunkPlan 计算分块数与边界情况', () => {
  assert.deepEqual(chunkPlan(0, 4), { size: 0, chunkSize: 4, chunkCount: 0 });
  assert.deepEqual(chunkPlan(4, 4), { size: 4, chunkSize: 4, chunkCount: 1 });
  assert.deepEqual(chunkPlan(5, 4), { size: 5, chunkSize: 4, chunkCount: 2 });
  assert.deepEqual(chunkPlan(-1, 4), { size: 0, chunkSize: 4, chunkCount: 0 });
  assert.equal(chunkPlan(100).chunkSize, engine.DEFAULT_CHUNK_SIZE);
  assert.equal(chunkPlan(100, 0).chunkSize, engine.DEFAULT_CHUNK_SIZE);
});

test('backoffMs 指数退避且有上限', () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(20), 30000);
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(-3), 1000);
});

test('内容变了但大小和时间都相同时会被漏判 —— 这是已知取舍', () => {
  // 用 size+mtime 做判定（rsync 同款），不逐文件算 sha256。
  // 同一秒内写入且字节数恰好相同的内容变更不会被检测到，
  // 只有靠低频全量校验兜底。这里把这个取舍固化下来，避免后人误以为它会捕获。
  const current = new Map([['a.txt', { size: 3, mtimeMs: 100 }]]);
  const index = { 'a.txt': { size: 3, mtimeMs: 100 } };
  assert.deepEqual(computePlan(current, index).toPush, []);
});

test('buildIgnoreMatcher 解析纯文件名匹配任意层级', () => {
  const m = buildIgnoreMatcher('node_modules');
  assert.equal(m('node_modules', true), true);
  assert.equal(m('a/node_modules', true), true);
  assert.equal(m('a/node_modules/x.js', false), true);
  assert.equal(m('src/app.js', false), false);
});

test('buildIgnoreMatcher 末尾 / 仅匹配目录', () => {
  const m = buildIgnoreMatcher('tmp/');
  assert.equal(m('tmp', true), true);
  assert.equal(m('tmp', false), false); // 同名文件不忽略
  assert.equal(m('a/tmp', true), true);
  assert.equal(m('tmp/cache/a.bin', false), true); // 目录规则覆盖其后代
  assert.equal(m('a/tmp/cache/a.bin', false), true);
});

test('buildIgnoreMatcher 通配与锚定', () => {
  const star = buildIgnoreMatcher('*.log');
  assert.equal(star('x.log', false), true);
  assert.equal(star('a/x.log', false), true);
  assert.equal(star('x.log.gz', false), false);

  const anchored = buildIgnoreMatcher('/build');
  assert.equal(anchored('build', true), true); // 根目录
  assert.equal(anchored('a/build', true), false); // 非根不匹配
});

test('buildIgnoreMatcher 跳过空行与注释', () => {
  const m = buildIgnoreMatcher('\n  # comment\n\nnode_modules\n');
  assert.equal(m('node_modules', true), true);
  assert.equal(m('other', false), false);
});

test('scanTree 用 ignore 排除用户规则', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'innernet-ign-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
  fs.writeFileSync(path.join(root, 'app.js'), 'app');
  fs.writeFileSync(path.join(root, 'debug.log'), 'log');
  const matcher = buildIgnoreMatcher('node_modules\n*.log');
  const found = scanTree(root, { ignore: (rel, isDir) => isInternalPath(rel) || matcher(rel, isDir) });
  assert.equal(found.has('app.js'), true);
  assert.equal(found.has('node_modules/x.js'), false);
  assert.equal(found.has('debug.log'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('computePlan 被忽略文件不触发回收', () => {
  const current = new Map([['app.js', { size: 1, mtimeMs: 1 }]]);
  const index = {
    'app.js': { size: 1, mtimeMs: 1 },
    'node_modules/x.js': { size: 1, mtimeMs: 1 }, // 已同步过，后加忽略
  };
  const matcher = buildIgnoreMatcher('node_modules');
  const plan = computePlan(current, index, matcher);
  assert.deepEqual(plan.toPush, []);
  assert.deepEqual(plan.toTrash, []); // 不回收被忽略的
});

test('extrasOnSlave 可按任务策略保留或清理从端排除项', () => {
  const current = new Map([['app.js', { size: 1, mtimeMs: 1 }]]);
  const remote = ['app.js', 'cache/a.bin', 'stray.txt'];
  const matcher = buildIgnoreMatcher('cache/');
  assert.deepEqual(extrasOnSlave(current, remote, matcher), ['stray.txt']);
  assert.deepEqual(extrasOnSlave(current, remote), ['cache/a.bin', 'stray.txt']);
});

test('carryFailures 失败文件保留旧快照，下一轮仍判为变更', () => {
  const current = new Map([
    ['ok.txt', { size: 1, mtimeMs: 1 }],
    ['fail-old.txt', { size: 2, mtimeMs: 2 }],
    ['fail-new.txt', { size: 3, mtimeMs: 3 }],
  ]);
  const prevIndex = {
    'ok.txt': { size: 1, mtimeMs: 1 },
    'fail-old.txt': { size: 1, mtimeMs: 1 }, // 旧快照（内容变了但本轮推送失败）
  };
  const next = carryFailures(toIndex(current), prevIndex, ['fail-old.txt', 'fail-new.txt']);
  const plan = computePlan(current, next);
  assert.deepEqual(plan.toPush, ['fail-new.txt', 'fail-old.txt']); // 失败文件下轮重推
  assert.deepEqual(plan.toTrash, []);
});

test('carryFailures 空失败列表时索引等于扫描快照', () => {
  const current = new Map([['a.txt', { size: 1, mtimeMs: 1 }]]);
  assert.deepEqual(carryFailures(toIndex(current), {}, []), toIndex(current));
});
