# InnerBridge（统一源码版）

> InnerBridge 0.2：P0-P5 功能已完成，当前通过 134 项自动化测试、ESLint 与生产构建检查。安全配对、P2P 传输、文件同步、访问记录、WOL、跨端通知和统一界面均已接入；P2P 文件夹默认无压缩传输并在接收端还原目录，也可按设置压缩为 ZIP。项目已进入 0.2.0 发布打包阶段。

同一套源码同时支持 Windows 共享端和 macOS 挂载端。应用根据运行平台自动显示对应功能，不再维护两份代码。

## 当前交付状态

- 当前统一源码目录：`/Users/brz/MyProject/InnerBridge`。
- 1.0 目录和旧目录仅作历史参考，不再双向同步代码。
- 干净源码约 1 MB，不包含依赖、构建产物、用户配置或运行日志。
- Node.js 24.19.0 + Electron 44 环境下，当前 `npm run check` 通过：ESLint、134 项测试（含群聊、发现、配对、传输、同步、WOL 与访问日志测试）和前端构建。
- macOS Apple Silicon 0.2.0 发布包已重新生成，并通过 DMG/ZIP 完整性与隔离启动检查；未配置 Apple Developer ID，首次打开方式见[项目使用指南](docs/项目使用指南.md)。Windows x64 安装包应在 Windows 环境执行 `npm run build:win` 生成。

## 从零开始

要求：Windows 10/11 或当前 macOS，Node.js **v24.19.0**（支持范围 `>=24.19.0 <25`）。项目使用 Electron **44.0.0**，其内置 Node 24.18.1，与外部 Node 24 构建环境保持同一主版本。

项目提供 `.nvmrc`、`.node-version`、Volta 配置和安装/启动前检查。Node 版本不满足要求时会直接给出提示，避免安装出一套不可复现的依赖。

国内网络下载 Electron 较慢时，可临时设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后再安装；两个一键脚本已经自动设置该镜像。

### 手动逐条执行

Windows 共享端请在“管理员 PowerShell”中执行：

```powershell
cd C:\path\to\InnerBridge
npm install
npm run runtime:check
npm run dev
```

macOS 挂载端请在终端中执行：

```bash
cd /path/to/InnerBridge
npm install
npm run runtime:check
npm run dev
```

`npm run dev` 会先检查并补齐 Electron 44 二进制，再启动 Vite 和 Electron，开发端口固定为 `6300`，适合日常调试，不需要每次打包。若只运行已构建的前端，可先执行 `npm run build`，再执行 `npx electron .`。

Electron 44 的 npm 包不再依赖 `postinstall` 自动下载二进制，因此 `npm install` 显示 `up to date` 不代表 `dist` 已就绪。`npm run electron:ensure` 会使用 `ELECTRON_MIRROR` 调用 `node node_modules/electron/install.js`，检查并补齐对应平台的 Electron 可执行文件。

### 一键脚本执行

- Windows：双击 [`启动 InnerBridge.bat`](<启动 InnerBridge.bat>)。脚本是 CRLF 换行，会请求管理员权限、检查 Node 24.19.0、首次自动安装依赖、补齐 Electron 二进制，然后启动 6300 端口的开发模式。
- macOS：双击 [`启动 InnerBridge.command`](<启动 InnerBridge.command>)。脚本会检查 Node 24.19.0、首次自动安装依赖，然后启动开发模式。

两个脚本都设置 Electron 镜像；Node 版本不符合要求时会停止并显示切换提示。

## 项目结构

```text
InnerBridge/
├── electron/                 # Electron 主进程、IPC、SMB、群聊与安全服务
│   ├── main.js               # 按 Windows/macOS 启用对应能力，注册全部 IPC
│   ├── preload.js             # 安全暴露 IPC API（host/sync/lan/wol/revocation 等）
│   ├── smb-mount.js           # macOS SMB 挂载与 LaunchAgent 脚本
│   ├── windows-share-acl.js   # Windows principal/ACL 校验
│   ├── chat-server.js         # HTTP/SSE 群聊、附件与共享清单接口
│   ├── chat-storage.js        # 聊天记录统计和缓存清理
│   ├── discovery-service.js    # UDP 49321 设备发现（定向子网广播）
│   ├── pairing.js / pairing-coordinator.js / pairing-relay.js / pairing-protocol.js
│   │                         # P3 配对服务、协调、转发与协议
│   ├── transfer-server.js / transfer-client.js
│   │                         # P4 原生传输服务端与客户端
│   ├── sync-server.js / sync-service.js
│   │                         # 文件夹同步：从端 HTTP 端点 + 主端编排（端口 7892）
│   ├── wol-service.js         # P5 远程唤醒 UDP 广播与上线探测
│   └── security/             # 安全辅助模块
├── core/                     # 跨平台纯逻辑（便于测试）
│   ├── device-schema.js / device-identity.js / capability-resolver.js / discovery.js
│   ├── light-auth.js         # Ed25519 挑战签发与验签（清单/传输/同步共用）
│   ├── credential-store.js    # 配对凭据与主机 SMB 密码（同套加密）
│   ├── revocation.js          # P3 解除配对撤销凭据签发/验签
│   ├── transfer.js            # P4 传输授权与 manifest
│   ├── sync-engine.js         # 文件夹同步纯函数（扫描/差异/回收区/退避/失败补偿）
│   ├── access-log.js          # 设备中心「访问过本机的设备」只读记录
│   └── wol.js                 # P5 魔术包构造与 WOL 状态机
├── src/                      # React 渲染进程
│   ├── App.jsx               # 平台路由和页签（含「文件夹同步」）
│   ├── components/           # 共享/挂载/群聊/传输/同步/设备中心/日志/服务设置
│   │   ├── ShareManager.jsx / MountManager.jsx
│   │   ├── DeviceCenter.jsx  # 含局域网其他设备区与 WOL 配置
│   │   ├── SyncPage.jsx       # 文件夹同步配置与状态
│   │   └── ...
│   └── styles.css             # 公共主题与布局
├── test/                     # Node 原生单元/集成测试（134 项用例）
├── scripts/                  # 运行环境检查和打包辅助脚本
├── build/                    # 图标和 macOS 打包脚本
├── docs/                     # 从零开始、架构、联调与版本排障文档
├── package.json              # Node 24/Electron 44 依赖、6300 端口与命令
├── package-lock.json         # 唯一依赖锁文件
├── .nvmrc / .node-version    # Node.js v24.19.0
├── 启动 InnerBridge.bat         # Windows 一键启动
└── 启动 InnerBridge.command     # macOS 一键启动
```

## 两端职责

- Windows：创建 SMB 共享、校验/修复共享 ACL、提供已签名的共享清单接口和群聊服务。
- macOS：通过轻量 API 拉取共享清单，手动挂载或安装用户级 LaunchAgent 自动挂载；可按主机维护统一 SMB 密码；新共享可在「自动挂载」轮询中自动挂载（每 60 秒检查已配对在线设备的新共享，需主机统一密码）。
- 公共能力（两端都可发起或参与）：设备发现、安全配对、P2P 传输（提议/接收确认/发送队列/文件夹默认无压缩传输）、文件夹同步（多任务、单向主从、配对码关联、失败补偿、停止联动）、访问过本机设备只读记录、远程唤醒（WOL）。
- 公共：React 界面、聊天（实名，必须携带本机 deviceId）、日志、配置格式和测试共用一份代码。

## 主机 SMB 密码维护（Mac 端）

- Windows 必须创建本地 SMB 账号并设密码，Mac 才能挂载；Mac 端按**主机**维护统一密码，N 个共享只填一次。
- 主机账号维护区可「设置/更新/删除」统一密码；更新时自动覆盖该主机所有共享的 `password`；缺省时挂载自动回退到主机密码。
- 同步来的新共享 `password` 为空也能挂载（用主机密码）。
- Windows 端共享卡片密码默认 `••••••••` 遮罩，眼睛按钮可临时显示，「复制连接信息」仍复制真实密码。
- 凭据存于 `hostCredentials.json`，与配对凭据使用同一套加密。

## 共享清单同步（轻量 API）

- macOS 向 Windows 的 `7890` 端口发两步请求：先 `POST /api/shares/challenge` 取一次性挑战，
  再用本机 Ed25519 私钥签名，然后 `POST /api/shares/manifest` 换取清单。
- Windows 只对**已配对**设备下发挑战，并用配对时留存的公钥验签；未注入签发器/校验器时
  这两个路由不注册，请求返回 404 而不是裸奔。
- 清单只含 `shareName` / `account` / `unified`，**SMB 密码不出网**，由 macOS 保存在本机复用。
- 因此不再需要安装 OpenSSH Server、配置端口、粘贴公钥授权和放行防火墙。

## 2.0 安全配对（P3）

- 发现使用 UDP `49321`；专用配对服务使用 TCP `7891`，不复用群聊/附件服务。
- 双端显示相同的六位一次性配对码，接收方必须手动输入并允许；支持拒绝、过期、错误码重试与解除配对。
- 解除配对是双向的：解除方用本机私钥签发撤销凭据送达对端，对端验签通过后立即解除并提示用户。
  对端离线时本机照样立即生效，对方下次操作被拒时会自动降级，不会长期停留在「已信任」的假象上。
- 成功后以稳定的 Ed25519 公钥指纹识别可信设备；发现到同一 `deviceId` 但指纹变化时，设备中心会阻断敏感操作并要求解除后重新配对。
- 私钥不进入公开设备资料或发现广播；发现广播仅携带公钥指纹摘要。
- P3 真实双机配对已完成验收，配对时双向留存对端 Ed25519 公钥（`/api/pair/status` 回传 `identityPublicKey`），解除配对的撤销凭据可正确验签。双机步骤见 [docs/P3-双机配对联调说明.md](docs/P3-双机配对联调说明.md)。

## 文件夹同步（多任务、单向主从、配对码、失败补偿、停止联动）

- 在「文件同步」页签以**任务**为单位管理：一次配置 = 一条同步任务，支持多条任务并存（各自目录、对端、忽略规则、启停状态独立）。
- **配对码**：主端任务自动生成 6 位 pairKey，从端任务表单填写此码；请求统一注入 pairKey，从端按 pairKey 匹配（解决两端任务 id 各自独立导致 404 的问题）。单条无码从端任务兜底兼容旧迁移。
- **同步邀请**：主端新建任务并指定从端后，通过已配对 Ed25519 身份发送签名邀请；从端自动切到文件同步页并打开预填表单，任务名、从端角色、配对码、主端设备/IP/端口均自动填写，只需选择从端目录。
- **运行中锁定**：`updateTask`/`removeTask` 仅在任务停止时允许；界面运行中显示 🔒 配置已锁定，按角色与运行态解锁「立即同步/清空索引/回收区」。
- **实时**：主端 `fs.watch` 递归监听 + 800ms 防抖；另设 5 分钟全量校验（size+mtime 比对）抗事件丢失。
- **失败补偿**：`carryFailures` —— 推送失败（重试耗尽）的文件在索引中保留旧快照（新文件不写入），下一轮 diff 自动重推；任务卡片显示「待补偿 N 个文件」。
- **停止联动**：主端或从端停止任务 → POST `/api/sync/notify`（签名鉴权）即时通知另一端；对端在当前页签上方弹出必须手动关闭的提示框，并在任务历史保留记录。`runCycle` 循环检查 `enabled` 支持中途取消。
- **回收区**：主端删除的文件在从端移入 `.innernet-trash/<时间戳>/<原路径>/`，默认保留 7 天，可手动恢复或清空；从端多余文件也在全量轮清进回收区。
- **鉴权**：复用配对 Ed25519 公钥验签（与共享清单同一套机制），未配对设备拿不到挑战。
- **分块**：大文件按 4MB 分块传输，每块独立校验，断点续传靠 missing 列表。
- 端口 `7892`，已纳入服务健康检查。从端目录勿落在 SMB 挂载卷上（`fs.watch` 网络卷不可靠）。

## 局域网设备访问记录与远程唤醒（P5）

- **访问过本机的设备**：设备中心只读记录访问过本机服务的设备（拉取共享清单、群聊发言、文件同步请求时记录 requesterId+IP+来源），**不主动扫描、不对任何设备发包**；仅显示与本机产生过实际交互的设备。
- **远程唤醒（WOL）**：为已配对设备配置目标 MAC 与广播地址后，离线时可发魔术包（6×FF + MAC×16，UDP 广播，每地址 3 次）；随后轮询探测对端上线（最长 30 秒），成功自动标记「已验证可唤醒」。
- 本机网卡 MAC 可在设备中心复制，供对端配置唤醒用；目标配置按 `deviceId` 存本机 `wol-targets.json`，不进发现广播。
- 按设计文档 §10 诚实原则：未配置不显示可唤醒；未验证明确标注「尚未实际验证」；唤醒失败给具体排查（电源/BIOS/有线网络）。
- 软件已实现并自动化验证；真实硬件关机唤醒需用户在有 WOL 支持的设备上执行一次（成功后 App 自动记录 verified）。

## 群聊能力

- 文字、图片、普通文件、压缩文件和文件夹附件；文件夹会自动压缩为 ZIP。
- 桌面端与手机网页均可选择文件夹，客户端压缩为 ZIP 后传输；最多 500 个文件、原始/压缩后均不超过 200MB。
- 支持把文件或文件夹直接拖入聊天区域；桌面端点击附件按钮后由程序自动判断文件、图片或文件夹，浏览器端保留文件/文件夹选择入口。
- 文本白名单覆盖常见代码、配置、数据、脚本和文档格式；图片支持 PNG、JPEG、GIF、WebP、BMP、TIFF、ICO、AVIF、HEIC 等常见格式。
- **实名进入群聊**：`/api/msg` 必须携带本机 `deviceId`（作为 `requesterId`），匿名请求被服务端拒绝（400）；昵称默认为本机设备名，避免局域网内冒名发言。
- 消息回复与可信引用快照。
- 最近 200 条消息搜索。
- SSE 实时消息、在线人数和 20 秒心跳。
- `clientId` 幂等发送，避免重复点击或网络重试产生重复消息。
- 桌面端和手机网页共用同一服务协议。
- Windows 共享端提供聊天记录与缓存管理窗口，可统计占用、查看消息和缓存的本机路径、清空记录、回收无引用附件或全部清空；管理操作仅通过本机 Electron IPC 开放。
- Windows 普通权限启动会显示红色权限警告；共享卡片的"复制连接信息"输出与导出清单相同的 JSON，可直接在 Mac 端导入。
- 群聊 P1-P2：未读计数/系统通知、@昵称高亮、Windows 本地 JSON/Markdown 历史导出，以及按消息 ID 删除管理。

2.0 以 1.0 稳定功能为基线并扩展了安全配对、P2P 传输（已重构完整链路）、文件夹同步（多任务 + 配对码 + 失败补偿 + 停止联动）与远程唤醒；历史问题、Electron 按需下载和端口说明见 [docs/版本更迭.md](docs/版本更迭.md)。

## P2P 传输（P4，已重构完整链路）

- LocalSend 风格侧栏布局：「接收 / 发送 / 设置」（`src/components/TransferPage.jsx`）。
- **挑战按配对公钥签发与校验**：接收端服务端用本机 Ed25519 私钥签发挑战，发送端用配对留存的公钥校验；不再依赖易过期的配对会话令牌。
- **token 鉴权**：offer 时签发 Bearer token，分块与状态接口凭此鉴权；`transferId` 绑定双方设备、配对授权和有效期。
- **IPC 已接通**：`transfer:offer / sends / listOffers / decide / status / selectFile`。
- 文件夹默认使用无压缩容器保持目录结构，接收端校验后自动还原文件夹；设置中可切换为 ZIP 压缩。传输本身使用流式分块，无文件大小限制。
- 发送历史持久保存，界面默认展示最近五条；已完成或失败记录可删除。缓存目录可在设置中修改，重启后完全生效。
- 接收目录选择保留在本机 Electron IPC 边界，远端不能指定保存目录；落盘前 SHA-256 校验后原子移动。
- 发布后仍建议在目标网络完成双机大文件吞吐、断网恢复和 WOL 硬件验收。

## 验证与构建

```bash
npm install
npm run check       # lint + test + 前端构建
npm run build:win   # Windows 安装包
npm run build:mac   # macOS DMG/ZIP
```

面向最终用户的完整说明见 [docs/项目使用指南.md](docs/项目使用指南.md)；开发步骤见 [docs/从零开始.md](docs/从零开始.md)，系统操作见 [docs/系统使用说明.md](docs/系统使用说明.md)，代码边界见 [docs/架构说明.md](docs/架构说明.md)，历史问题与版本变更见 [docs/版本更迭.md](docs/版本更迭.md)。
