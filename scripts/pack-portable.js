/**
 * 便携版打包：把 win-unpacked 目录 + README.md 打成 zip
 * 用法：npm run build:portable（先 vite build + electron-builder --win dir）
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;
const releaseDir = path.join(__dirname, '..', 'release');
const unpacked = path.join(releaseDir, 'win-unpacked');
const folderName = `InnerNet-Portable-${version}-win-x64`;
const staging = path.join(releaseDir, folderName);
const zipFile = path.join(releaseDir, `${folderName}.zip`);

if (!fs.existsSync(unpacked)) {
  console.error('未找到 win-unpacked，请先执行 electron-builder --win dir');
  process.exit(1);
}

// 1. 准备 staging 目录（win-unpacked 内容 + README.md）
fs.rmSync(staging, { recursive: true, force: true });
fs.cpSync(unpacked, staging, { recursive: true });
const readme = path.join(__dirname, '..', 'README.md');
if (!fs.existsSync(readme)) {
  console.error('未找到 README.md');
  process.exit(1);
}
fs.copyFileSync(readme, path.join(staging, 'README.md'));
console.log('staging:', staging);

// 2. 打 zip（系统自带 Compress-Archive）
fs.rmSync(zipFile, { force: true });
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${staging}' -DestinationPath '${zipFile}' -CompressionLevel Optimal"`,
  { stdio: 'inherit' }
);

// 3. 清理 staging
fs.rmSync(staging, { recursive: true, force: true });

const size = (fs.statSync(zipFile).size / 1048576).toFixed(1);
console.log(`\n✅ 便携版已生成: ${zipFile} (${size}MB)`);
console.log(`   解压后内含 README.md 使用说明`);
