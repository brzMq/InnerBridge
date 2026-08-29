# InnerNet 内网共享（统一源码版）

> InnerNet 2.0 开发线：P0-P2 已完成并有双机发现记录；P3 安全配对已完成代码与自动化验证，等待 Windows/macOS 双机 Gate 验收。1.0 稳定功能保持兼容。

同一套源码同时支持 Windows 共享端和 macOS 挂载端。应用根据运行平台自动显示对应功能，不再维护两份代码。

## 当前交付状态

- 2.0 独立维护目录：`/Users/brz/MyProject/innerNet-2.0.0`
- 1.0 目录和旧目录仅作历史参考，不再双向同步代码。
- 干净源码约 1 MB，不包含依赖、构建产物、用户配置或运行日志。
- Node.js 24.19.0 + Electron 44 环境下，当前 `npm run check` 通过：ESLint、46 项测试（含群聊、发现、配对与传输测试）和前端构建。

## 从零开始

要求：Windows 10/11 或当前 macOS，Node.js **v24.19.0**（支持范围 `>=24.19.0 <25`）。项目使用 Electron **44.0.0**，其内置 Node 24.18.1，与外部 Node 24 构建环境保持同一主版本。

项目提供 `.nvmrc`、`.node-version`、Volta 配置和安装/启动前检查。Node 版本不满足要求时会直接给出提示，避免安装出一套不可复现的依赖。

国内网络下载 Electron 较慢时，可临时设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后再安装；两个一键脚本已经自动设置该镜像。

### 手动逐条执行

Windows 共享端请在“管理员 PowerShell”中执行：

```powershell
cd F:\VibeCoding\inner-net-unified
npm install
npm run runtime:check
npm run dev
```

macOS 挂载端请在终端中执行：

```bash
cd /path/to/inner-net-unified
npm install
npm run runtime:check
npm run dev
```

`npm run dev` 会先检查并补齐 Electron 44 二进制，再启动 Vite 和 Electron，开发端口固定为 `6300`，适合日常调试，不需要每次打包。若只运行已构建的前端，可先执行 `npm run build`，再执行 `npx electron .`。

Electron 44 的 npm 包不再依赖 `postinstall` 自动下载二进制，因此 `npm install` 显示 `up to date` 不代表 `dist` 已就绪。`npm run electron:ensure` 会使用 `ELECTRON_MIRROR` 调用 `node node_modules/electron/install.js`，检查并补齐对应平台的 Electron 可执行文件。

### 一键脚本执行

- Windows：双击 [`启动 InnerNet.bat`](<启动 InnerNet.bat>)。脚本是 CRLF 换行，会请求管理员权限、检查 Node 24.19.0、首次自动安装依赖、补齐 Electron 二进制，然后启动 6300 端口的开发模式。
- macOS：双击 [`启动 InnerNet.command`](<启动 InnerNet.command>)。脚本会检查 Node 24.19.0、首次自动安装依赖，然后启动开发模式。

两个脚本都设置 Electron 镜像；Node 版本不符合要求时会停止并显示切换提示。

## 项目结构

```text
inner-net-unified/
├── electron/                 # Electron 主进程、IPC、SMB/SSH、群聊与安全服务
│   ├── main.js               # 按 Windows/macOS 启用对应能力
│   ├── preload.js             # 安全暴露 IPC API
│   ├── smb-mount.js           # macOS SMB 挂载与 LaunchAgent 脚本
│   ├── windows-share-acl.js   # Windows principal/ACL 校验
│   ├── chat-server.js         # HTTP/SSE 群聊与附件服务
│   └── chat-storage.js        # 聊天记录统计和缓存清理
├── src/                      # React 渲染进程
│   ├── App.jsx               # 平台路由和页签
│   ├── components/           # 共享、挂载、群聊、日志界面
│   └── styles.css             # 公共主题与布局
├── test/                     # Node 原生单元/集成测试
├── scripts/                  # 运行环境检查和打包辅助脚本
├── build/                    # 图标和 macOS 打包脚本
├── docs/                     # 从零开始、架构、群聊和版本排障文档
├── package.json              # Node 24/Electron 44 依赖、6300 端口与命令
├── package-lock.json         # 唯一依赖锁文件
├── .nvmrc / .node-version    # Node.js v24.19.0
├── 启动 InnerNet.bat         # Windows 一键启动
└── 启动 InnerNet.command     # macOS 一键启动
```

## 两端职责

- Windows：创建 SMB 共享、校验/修复共享 ACL、提供 SSH 清单和群聊服务。
- macOS：通过 SSH 同步清单，手动挂载或安装用户级 LaunchAgent 自动挂载。
- 公共：React 界面、聊天、日志、配置格式和测试共用一份代码。

## 2.0 安全配对（P3）

- 发现使用 UDP `49321`；专用配对服务使用 TCP `7891`，不复用群聊/附件服务。
- 双端显示相同的六位一次性配对码，接收方必须手动输入并允许；支持拒绝、过期、错误码重试与解除配对。
- 成功后以稳定的 Ed25519 公钥指纹识别可信设备；发现到同一 `deviceId` 但指纹变化时，设备中心会阻断敏感操作并要求解除后重新配对。
- 私钥不进入公开设备资料或发现广播；发现广播仅携带公钥指纹摘要。
- 真实双机配对仍待验收，步骤见 [docs/P3-双机配对联调说明.md](docs/P3-双机配对联调说明.md)。

## 群聊能力

- 文字、图片、受限文本附件和压缩文件（zip/7z/rar/tar/gz 等）。
- 桌面端与手机网页均可选择文件夹，客户端压缩为 ZIP 后传输；最多 500 个文件、原始/压缩后均不超过 200MB。
- 支持把文件或文件夹直接拖入聊天区域；附件入口已精简为一个按钮，菜单中选择文件/图片或文件夹。
- 文本白名单覆盖常见代码、配置、数据、脚本和文档格式；图片支持 PNG、JPEG、GIF、WebP、BMP、TIFF、ICO、AVIF、HEIC 等常见格式。
- 消息回复与可信引用快照。
- 最近 200 条消息搜索。
- SSE 实时消息、在线人数和 20 秒心跳。
- `clientId` 幂等发送，避免重复点击或网络重试产生重复消息。
- 桌面端和手机网页共用同一服务协议。
- Windows 共享端提供聊天记录与缓存管理窗口，可统计占用、查看消息和缓存的本机路径、清空记录、回收无引用附件或全部清空；管理操作仅通过本机 Electron IPC 开放。
- Windows 普通权限启动会显示红色权限警告；共享卡片的“复制连接信息”输出与导出清单相同的 JSON，可直接在 Mac 端导入。
- 群聊 P1-P2：未读计数/系统通知、@昵称高亮、Windows 本地 JSON/Markdown 历史导出，以及按消息 ID 删除管理。

当前 1.0 版本以现有功能为基线；历史问题、Electron 按需下载和端口说明见 [docs/版本更迭.md](docs/版本更迭.md)。

## 验证与构建

```bash
npm install
npm run check       # lint + test + 前端构建
npm run build:win   # Windows 安装包
npm run build:mac   # macOS DMG/ZIP
```

详细步骤见 [docs/从零开始.md](docs/从零开始.md)，最终用户操作见 [docs/系统使用说明.md](docs/系统使用说明.md)，代码边界见 [docs/架构说明.md](docs/架构说明.md)，常见问题与版本变更见 [docs/版本更迭.md](docs/版本更迭.md)。
