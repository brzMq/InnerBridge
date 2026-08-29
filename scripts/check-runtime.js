const REQUIRED = { major: 24, minor: 19, patch: 0 };

function compareVersion(actual, required) {
  for (const key of ['major', 'minor', 'patch']) {
    if (actual[key] !== required[key]) return actual[key] > required[key] ? 1 : -1;
  }
  return 0;
}

const [major, minor, patch] = process.versions.node.split('.').map(Number);
const actual = { major, minor, patch };
const supported = major === REQUIRED.major && compareVersion(actual, REQUIRED) >= 0;

if (!supported) {
  console.error(`InnerNet 需要 Node.js >=24.19.0 <25，当前版本为 v${process.versions.node}。`);
  console.error('请切换到 Node.js v24.19.0 后重新执行 npm install。');
  process.exit(1);
}

console.log(`运行环境检查通过：Node.js v${process.versions.node}`);
