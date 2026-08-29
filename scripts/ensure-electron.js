const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const packageFile = require.resolve('electron/package.json');
const electronDir = path.dirname(packageFile);
const binary = process.platform === 'win32'
  ? path.join(electronDir, 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(electronDir, 'dist', 'electron');

if (fs.existsSync(binary)) {
  console.log(`Electron 二进制已就绪：${path.relative(process.cwd(), binary)}`);
  process.exit(0);
}

const installer = path.join(electronDir, 'install.js');
if (!fs.existsSync(installer)) {
  console.error(`找不到 Electron 安装脚本：${installer}`);
  process.exit(1);
}

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
};
console.log('Electron 44 二进制未就绪，执行 install.js 按需下载…');
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', env });
if (result.error) {
  console.error(`Electron 二进制下载失败：${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0 || !fs.existsSync(binary)) {
  console.error('Electron 二进制下载未完成，请检查网络或 ELECTRON_MIRROR。');
  process.exit(result.status || 1);
}
console.log(`Electron 二进制已就绪：${path.relative(process.cwd(), binary)}`);
