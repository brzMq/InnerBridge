@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js v24.19.0。
  pause
  exit /b 1
)

node scripts\check-runtime.js
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm run electron:ensure
if errorlevel 1 (
  pause
  exit /b 1
)

call npm run dev
