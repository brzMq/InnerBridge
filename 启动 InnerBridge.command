#!/bin/sh
set -eu

# 始终以当前 InnerBridge 项目目录为工作目录，不依赖项目放置位置或旧目录名。
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js v24.19.0。"
  exit 1
fi

node scripts/check-runtime.js

if [ ! -f node_modules/electron/package.json ]; then
  echo "首次运行，正在安装依赖..."
  npm install
fi

npm run electron:ensure
npm run dev
