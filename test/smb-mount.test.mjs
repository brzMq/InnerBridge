import assert from 'node:assert/strict';
import { test } from 'node:test';
import mountHelpers from '../electron/smb-mount.js';

const {
  buildAutoMountScript,
  buildAutofsMap,
  buildLaunchAgentPlist,
  buildSmbUrl,
  escapeAutofsKey,
  isMountPointMounted,
  redactMountError,
} = mountHelpers;

const sample = {
  host: '192.168.5.50',
  account: 'BRZ\\brz',
  password: 'p@ ss:$word',
  shareName: 'AI Agent 中文',
  mountPoint: '/Users/brz/Shared/AI Agent 中文',
};

test('SMB URL 编码账号、密码和共享名，且不触发 shell', () => {
  assert.equal(
    buildSmbUrl(sample),
    '//BRZ%5Cbrz:p%40%20ss%3A%24word@192.168.5.50/AI%20Agent%20%E4%B8%AD%E6%96%87'
  );
});

test('autofs direct map 使用 // URL 并转义挂载点空格', () => {
  const map = buildAutofsMap([sample]);
  assert.match(map, /^\/Users\/brz\/Shared\/AI\\ Agent\\ 中文 /);
  assert.match(map, /-fstype=smbfs,nosuid,noowners \/\//);
  assert.doesNotMatch(map, / :\/\//);
});

test('autofs key 转义空格、井号和反斜杠', () => {
  assert.equal(escapeAutofsKey('/A B/#C\\D'), '/A\\ B/\\#C\\\\D');
});

test('挂载错误不会泄露密码', () => {
  const msg = redactMountError(new Error(`bad ${sample.password} ${encodeURIComponent(sample.password)}`), sample);
  assert.doesNotMatch(msg, /p@ ss|p%40%20ss/);
});

test('按目标目录识别已挂载共享，避免重复挂载误报 ACL', () => {
  const output = [
    '//brz@192.168.5.50/AI%20Agent on /Users/brz/Shared/AI Agent 中文 (smbfs, nodev, nosuid)',
    '//brz@192.168.5.50/Redis on /Users/brz/Shared/Redis (smbfs, nodev, nosuid)',
  ].join('\n');
  assert.equal(isMountPointMounted(output, '/Users/brz/Shared/AI Agent 中文'), true);
  assert.equal(isMountPointMounted(output, '/Users/brz/Shared/AI Agent'), false);
  assert.equal(isMountPointMounted(output, ''), false);
});

test('自动挂载脚本使用固定命令并正确引用路径', () => {
  const script = buildAutoMountScript([sample]);
  assert.match(script, /\/usr\/bin\/nc -z -w 3 '192\.168\.5\.50' 445/);
  assert.match(script, /\/sbin\/mount -t smbfs '\/\/BRZ%5Cbrz:/);
  assert.match(script, /'\/Users\/brz\/Shared\/AI Agent 中文'/);
  assert.match(script, /failed=0/);
  assert.match(script, /exit "\$failed"/);
});

test('LaunchAgent 每 30 秒运行且路径 XML 转义', () => {
  const plist = buildLaunchAgentPlist({
    label: 'cn.test',
    scriptPath: '/A&B/run.sh',
    stdoutPath: '/tmp/out.log',
    stderrPath: '/tmp/error.log',
  });
  assert.match(plist, /<integer>30<\/integer>/);
  assert.match(plist, /\/A&amp;B\/run\.sh/);
});
