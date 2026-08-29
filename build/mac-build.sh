#!/bin/bash
# ============================================
# InnerNet macOS 一键打包脚本
# 用法：在 Mac 上执行  bash build/mac-build.sh
# ============================================
set -e
cd "$(dirname "$0")/.."

echo "📦 InnerNet macOS 打包开始"
echo "--------------------------"

# 1. 检查 Node.js（与开发、CI 共用同一版本规则）
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装："
  echo "   nvm install 24.19.0 && nvm use 24.19.0"
  exit 1
fi
node scripts/check-runtime.js
echo "✅ Node: $(node -v)  npm: $(npm -v)"

# 2. 安装依赖
# Electron 44 不再依赖 npm postinstall 下载二进制；通过 install.js 显式按需下载。
# 通过 ELECTRON_MIRROR 走 npmmirror 镜像，避免二进制下载失败。
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
echo "⬇️  安装依赖（首次需下载 Electron 44，已走国内镜像）..."
npm install --registry=https://registry.npmmirror.com

# npm install 可能显示 up to date，但不会自动补 Electron 44 二进制。
npm run electron:ensure

# 3. 检查 Electron 二进制是否下载成功
if [ ! -d "node_modules/electron/dist" ] || [ ! -f "node_modules/electron/path.txt" ]; then
  echo "⚠️  Electron 二进制未就绪（缺 dist 或 path.txt），可能是 npm 的 allow-scripts 机制拦截，执行："
  echo "   npm approve-scripts electron && npm rebuild electron"
  exit 1
fi

# 4. 打包
echo "🔨 构建 macOS 应用..."
npx electron-builder --mac

echo ""
echo "✅ 完成！产物在 release/ 目录："
ls -lh release/*.dmg release/*.zip 2>/dev/null || ls -lh release/
echo ""
echo "安装：双击 .dmg → 把 InnerNet 拖入「应用程序」"
echo "首次打开未签名应用：右键图标 → 打开（或执行 xattr -cr /Applications/InnerNet*.app）"
