/**
 * InnerNet 主进程
 * Windows 端：SMB 共享管理（net user / icacls / net share）
 * macOS 端：聚合挂载管理（mount_smbfs / autofs）
 */
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { startChatServer } = require('./chat-server');
const { storageStats, clearChatStorage } = require('./chat-storage');
const ssh = require('./ssh');
const { loadOrCreateIdentity } = require('../core/device-identity');
const { buildLocalDevice } = require('../core/capability-resolver');
const { startDiscovery } = require('./discovery-service');
const { createCredentialStore } = require('../core/credential-store');
const { startTransferServer } = require('./transfer-server');
const { hashFile } = require('../core/transfer');
const net = require('net');
const dgram = require('dgram');
const { DEFAULT_PORTS, RANGES, normalizeServicePorts, describePort } = require('../core/service-health');
const { startPairingServer } = require('./security/pairing-service');
const {
  hasFullAllowAccess,
  normalizeWindowsPrincipal,
  parseAccessJson,
} = require('./windows-share-acl');
const {
  buildAutoMountScript,
  buildLaunchAgentPlist,
  buildSmbUrl,
  isMountPointMounted,
  redactMountError,
  validateMount,
} = require('./smb-mount');

const PLATFORM = process.platform; // win32 | darwin
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';

// ---------- 单实例锁（防止多开导致聊天端口/配置竞争） ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
let mainWindow = null;
app.on('second-instance', () => {
  logEvent('warn', 'app', '检测到第二实例，聚焦已有窗口');
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ---------- 基础工具 ----------

/** 执行系统命令，正确处理 Windows GBK 输出 */
function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 30000,
    ...opts,
  });
  const decode = (buf) => {
    if (!buf) return '';
    try {
      // Windows 中文系统 cmd 输出为 GBK，macOS 为 UTF-8
      return new TextDecoder(IS_WIN ? 'gbk' : 'utf-8').decode(buf);
    } catch {
      return buf.toString('utf-8');
    }
  };
  const stdout = decode(res.stdout).trim();
  const stderr = decode(res.stderr).trim();
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) {
    throw new Error(stderr || stdout || `命令失败(${cmd} ${args.join(' ')})`);
  }
  return stdout;
}

// ---------- 运行日志（带时间戳，实时推送渲染进程） ----------
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
let logSeq = 0;

/** 推送给所有渲染窗口（窗口销毁时跳过） */
function emitLog(entry) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send('log:event', entry);
      } catch { /* ignore */ }
    }
  }
}

/**
 * 记录一条运行日志
 * @param {string} level   info | warn | error
 * @param {string} source  模块/过程名（如 chat / share / mount / ssh / app）
 * @param {string} message 日志内容（自动附带 ISO 时间戳）
 */
function logEvent(level, source, message) {
  const entry = {
    seq: ++logSeq,
    ts: new Date().toISOString(),
    level,
    source,
    message: String(message),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  emitLog(entry);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${source}] ${message}`);
}

/** 生成随机密码（去掉易混字符） */
function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#%';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/** 随机账号名 */
function genAccount() {
  return 'share_' + crypto.randomBytes(3).toString('hex').slice(0, 6);
}

/**
 * 共享名清洗
 * - 替换 net share 非法字符（半角：" / \ [ ] : | < > + = ; , ? *）
 * - 替换全角标点/全角括号/全角空格，避免在 net share 命令行解析上出意外
 * - 统一各种破折号为半角 -，去尾部连续 . 和空格（Windows 共享名不允许）
 * - 限制 80 字符
 */
function cleanShareName(name) {
  const cleaned = String(name || '')
    .replace(/[*?\/\\|:<>"+=;,\[\]()（）]/g, '_') // 半角非法字符 + 全角括号
    .replace(/[—–]+/g, '-')                       // 全/半破折号统一
    .replace(/[\s\u3000]+/g, ' ')                  // 全角空格 → 半角空格
    .replace(/[。，、！？：；]/g, '_')              // 全角标点 → _
    .replace(/[.\s]+$/, '')                        // 去尾部连续 . 与空格
    .trim()
    .slice(0, 80);
  return cleaned || 'share';
}

/** 目录名 → 合法共享名 */
function toShareName(dirPath) {
  const base = path.basename(dirPath);
  if (/^\d+$/.test(base)) return 's_' + base; // 纯数字非法
  return cleanShareName(base);
}

// ---------- 数据存储 ----------

const DATA_DIR = app.getPath('userData');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const MOUNTS_FILE = path.join(DATA_DIR, 'mounts.json');
const CHAT_MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl');
const CHAT_IMAGES_DIR = path.join(DATA_DIR, 'chat-images');
const CHAT_FILES_DIR = path.join(DATA_DIR, 'chat-files');
const TRANSFER_DIR = path.join(DATA_DIR, 'transfer');
// 提权脚本目录：Temp 下无中文无空格路径（PowerShell 5.1 编码兼容）
const SCRIPTS_DIR = path.join(os.tmpdir(), 'inner-net-scripts');

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}
const loadShares = () => loadJSON(SHARES_FILE, []);
const saveShares = (s) => saveJSON(SHARES_FILE, s);
const loadMounts = () => loadJSON(MOUNTS_FILE, []);
const saveMounts = (m) => saveJSON(MOUNTS_FILE, m);

// 应用级设置（统一账号模式开关等）
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const loadSettings = () => loadJSON(SETTINGS_FILE, {});
const saveSettings = (s) => saveJSON(SETTINGS_FILE, s);

// ---------- 权限 ----------

function isAdmin() {
  if (!IS_WIN) return null;
  try {
    runCmd('net', ['session']);
    return true;
  } catch {
    return false;
  }
}

// ---------- Windows 共享命令 ----------

/** 建本地账号（已存在则跳过） */
function verifyUserCredentials(account, password) { const name = String(account || '').trim(); const pwd = String(password || ''); if (!name || !pwd) throw new Error('请输入已存在的本地 Windows 用户名和密码'); const list = runCmd('net', ['user']); if (!list.toLowerCase().includes(name.toLowerCase())) throw new Error(`Windows 本地用户不存在：${name}，请先在系统中创建用户`); return name; }
function ensureUser(account, password) {
  const list = runCmd('net', ['user']);
  if (new RegExp(`^${account}\\b`, 'im').test(list)) return false;
  runCmd('net', ['user', account, password, '/add']);
  return true;
}

/**
 * 目录授权：仅为共享账号添加 NTFS 显式授权，保留/恢复继承。
 * - `icacls /grant` 是共享必须的 NTFS 权限，失败必须抛错。
 * - 不再使用 `icacls /inheritance:r`：移除继承会把文件夹 ACL 改坏，导致用户
 *   在资源管理器里需要重新授权才能进入（即便共享最终失败也已损坏目录）。
 * - 额外 `icacls /inheritance:e` 确保继承开启：可修复历史上被 /inheritance:r
 *   破坏过的文件夹（再操作一次即自愈），对正常文件夹是无害的 no-op。
 * @returns {string[]} warnings
 */
function grantDir(dirPath, account) {
  const warnings = [];
  try {
    runCmd('icacls', [dirPath, '/grant', `${account}:(OI)(CI)F`, '/T', '/C']);
  } catch (e) {
    throw new Error(`icacls /grant 失败 (${dirPath}): ${e.message}`);
  }
  try {
    runCmd('icacls', [dirPath, '/inheritance:e']);
  } catch {
    // 继承已开启或无需调整时该命令可能报错，忽略（不影响共享与文件夹访问）
  }
  return warnings;
}

/** 从目录移除某账号的 ACE（迁移统一账号时清理旧账号残留，避免孤儿 SID）；失败仅记录不影响主流程 */
function revokeDirFromAccount(dirPath, account) {
  try {
    runCmd('icacls', [dirPath, '/remove', account, '/T', '/C']);
  } catch (e) {
    console.warn(`[revokeDirFromAccount] 清理 ${account} 的目录 ACE 失败（可忽略）:`, e.message);
  }
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Read SMB share-level ACL through the structured PowerShell API. */
function getSmbShareAccess(shareName) {
  const script =
    `$items = @(Get-SmbShareAccess -Name ${psString(shareName)} -ErrorAction Stop | ForEach-Object { ` +
    `[PSCustomObject]@{ accountName = [string]$_.AccountName; ` +
    `isFull = ($_.AccessRight.ToString() -eq 'Full'); ` +
    `isAllow = ($_.AccessControlType.ToString() -eq 'Allow') } }); ` +
    `ConvertTo-Json -InputObject $items -Compress`;
  return parseAccessJson(runCmd('powershell.exe', ['-NoProfile', '-Command', script]));
}

/** Rebuild a damaged SMB share security descriptor while preserving its path/description. */
function rebuildSmbShareAccess(shareName, principal) {
  const script =
    `$old = Get-SmbShare -Name ${psString(shareName)} -ErrorAction Stop; ` +
    `$sharePath = [string]$old.Path; $description = [string]$old.Description; ` +
    `Remove-SmbShare -Name ${psString(shareName)} -Force -Confirm:$false -ErrorAction Stop; ` +
    `try { ` +
    `  if ($description) { ` +
    `    New-SmbShare -Name ${psString(shareName)} -Path $sharePath -Description $description ` +
    `      -FullAccess ${psString(principal)} -ErrorAction Stop | Out-Null ` +
    `  } else { ` +
    `    New-SmbShare -Name ${psString(shareName)} -Path $sharePath ` +
    `      -FullAccess ${psString(principal)} -ErrorAction Stop | Out-Null ` +
    `  } ` +
    `} catch { ` +
    `  $original = $_; ` +
    `  New-SmbShare -Name ${psString(shareName)} -Path $sharePath -ErrorAction SilentlyContinue | Out-Null; ` +
    `  throw $original ` +
    `}`;
  runCmd('powershell.exe', ['-NoProfile', '-Command', script]);
}

/** Ensure a valid Full/Allow ACE; rebuild damaged shares when Grant fails. */
function ensureSmbShareAccess(shareName, account) {
  const principal = normalizeWindowsPrincipal(account, os.hostname());
  let entries = getSmbShareAccess(shareName);
  if (hasFullAllowAccess(entries, principal)) {
    return { principal, repaired: false, repairMode: null, entries };
  }

  const script =
    `Grant-SmbShareAccess -Name ${psString(shareName)} -AccountName ${psString(principal)} ` +
    `-AccessRight Full -Force -ErrorAction Stop | Out-Null`;
  let grantError = null;
  try {
    runCmd('powershell.exe', ['-NoProfile', '-Command', script]);
    entries = getSmbShareAccess(shareName);
    if (hasFullAllowAccess(entries, principal)) {
      return { principal, repaired: true, repairMode: 'grant', entries };
    }
  } catch (e) {
    grantError = e;
  }

  rebuildSmbShareAccess(shareName, principal);
  entries = getSmbShareAccess(shareName);
  if (!hasFullAllowAccess(entries, principal)) {
    const actual = entries.map((x) => x.accountName || '?').join(', ') || '(空)';
    const grantInfo = grantError ? `；Grant 失败: ${grantError.message}` : '';
    throw new Error(`重建后共享级 ACL 验证失败：期望 ${principal}, 实际 ${actual}${grantInfo}`);
  }
  return {
    principal,
    repaired: true,
    repairMode: 'rebuild',
    entries,
    grantError: grantError ? grantError.message : null,
  };
}

/**
 * 启动自愈（仅 Windows）。NTFS 历史修复只跑一次；SMB 共享级 ACL 每次启动都校验。
 * 对已有共享目录开启继承 + 确保 NTFS/共享级账号授权，幂等、无害：
 * - 可自动修复早期版本 `icacls /inheritance:r` 留下的 ACL 损坏（点击需重新授权），
 *   无需任何手动修复脚本；正常目录上则是 no-op。
 * - 失败仅记日志，不阻断启动；仅在具备管理员权限（能真正执行）时落盘标记，
 *   避免 dev 非管理员误标记为已完成。
 */
function healExistingShareAcls() {
  if (!IS_WIN) return;
  try {
    if (!isAdmin()) {
      logEvent('warn', 'share', '启动 ACL 检查跳过：当前进程非管理员');
      return;
    }
    const settings = loadSettings();
    const needsNtfsHeal = !settings.aclSelfHealV1;
    const shares = loadShares();
    for (const s of shares) {
      if (!s.dirPath || !s.account) continue;
      if (needsNtfsHeal) {
        try {
          runCmd('icacls', [s.dirPath, '/inheritance:e', '/T', '/C']);
          runCmd('icacls', [s.dirPath, '/grant', `${s.account}:(OI)(CI)F`, '/T', '/C']);
          logEvent('info', 'share', `启动自愈：修复共享目录 ACL「${s.shareName}」(${s.dirPath})`);
        } catch (e) {
          logEvent('warn', 'share', `NTFS ACL 自愈跳过「${s.shareName}」: ${e.message}`);
        }
      }
      try {
        const result = ensureSmbShareAccess(s.shareName, s.account);
        if (result.repaired) {
          const action = result.repairMode === 'rebuild' ? '已重建共享并修复' : '已追加授权并修复';
          logEvent('info', 'share', `共享级 ACL ${action}「${s.shareName}」→ ${result.principal}`);
        }
      } catch (e) {
        logEvent('warn', 'share', `共享级 ACL 检查失败「${s.shareName}」: ${e.message}`);
      }
    }
    if (needsNtfsHeal) {
      try {
        settings.aclSelfHealV1 = true;
        saveSettings(settings);
      } catch (e) {
        logEvent('warn', 'share', `启动自愈标记写入失败（下次启动重试）: ${e.message}`);
      }
    }
  } catch (e) {
    logEvent('error', 'share', `启动自愈异常: ${e.message}`);
  }
}

/**
 * 建共享（一步带授权 + 回滚）
 * 使用 `net share <name>=<path> /grant:<account>,FULL` 一步完成：
 * - /grant 仅在创建语法中受官方文档支持；拆成两步后
 *   `net share <name> /grant:...` 修改已有共享在某些系统上会报 3505
 *   "使用的选项数值不正确"。
 * - 失败时尝试 /delete 回滚，避免留下无授权共享。
 */
function createShare(shareName, dirPath, account) {
  const grantTarget = normalizeWindowsPrincipal(account, os.hostname());
  try {
    runCmd('net', ['share', `${shareName}=${dirPath}`, `/grant:${grantTarget},FULL`]);
    // net.exe exit 0 is insufficient: affected systems can silently create "BRZ\" empty ACE.
    ensureSmbShareAccess(shareName, grantTarget);
  } catch (e) {
    try {
      runCmd('net', ['share', shareName, '/delete']);
    } catch { /* 回滚失败也不影响主错误抛出 */ }
    throw new Error(`net share 失败 (${shareName}=${dirPath}, ${grantTarget}): ${e.message}`);
  }
  return runCmd('net', ['share', shareName]);
}

/** 校验本地盘符路径（net share 不支持 UNC/网络路径） */
function assertLocalPath(dirPath) {
  if (!/^[a-zA-Z]:[\\/]/.test(dirPath)) {
    throw new Error(`不支持该路径（仅支持本地盘符路径，如 D:\\文件夹）：${dirPath}`);
  }
}

/** 删共享（不删文件） */
function removeShare(shareName) {
  runCmd('net', ['share', shareName, '/delete']);
}

/**
 * 共享失败时对目录做一次 ACL 诊断（仅当错误像"系统错误 5 / 拒绝访问"才调）
 * 列出关键 ACE + 高亮 DENY 规则 / 缺失 SYSTEM 全权
 */
function diagnoseShareAccess(dirPath) {
  try {
    const out = runCmd('icacls', [dirPath]);
    const lines = out.split('\n').filter(Boolean);
    const head = lines.slice(0, 20);
    const deny = /(DENY)/i.test(out);
    const sysFull = /SYSTEM:[^,\n]*F/i.test(out);
    const admFull = /BUILTIN\\Administrators:[^,\n]*F|\\Administrators:[^,\n]*F/i.test(out);
    const headTxt = head.map((l) => '  ' + l).join('\n');
    const tips = [];
    if (deny) tips.push('发现 (DENY) 规则 → 该目录对某些账号显式拒绝访问，net share 内部 token 命中会被拒');
    if (!sysFull) tips.push('缺少 SYSTEM: (F) → net share 内部使用 SYSTEM token 创建共享，可能因此被拒');
    if (!admFull) tips.push('缺少 BUILTIN\\Administrators: (F) → 管理员对该目录权限不足');
    const tipTxt = tips.length ? '\n  提示:\n    - ' + tips.join('\n    - ') : '';
    return `ACL 诊断 (${dirPath}):\n${headTxt}${tipTxt}`;
  } catch (e) {
    return 'ACL 诊断失败: ' + (e.message || e);
  }
}

/** 删账号 */
function removeUser(account) {
  try {
    runCmd('net', ['user', account, '/delete']);
  } catch { /* 忽略删除失败 */ }
}

// ---------- macOS 挂载命令 ----------

/**
 * 配置用户级自动挂载任务。
 * macOS 26 + SIP 禁止管理员脚本追加 /etc/auto_master，因此不再修改系统 autofs
 * 文件；改用 LaunchAgent 登录启动 + 每 30 秒重试，效果等价且无需管理员密码。
 */
function applyAutofs(mounts) {
  const label = 'cn.brz.innernet.automount';
  const taskDir = path.join(DATA_DIR, 'automount');
  const scriptPath = path.join(taskDir, 'mount-shares.sh');
  const stdoutPath = path.join(taskDir, 'automount.log');
  const stderrPath = path.join(taskDir, 'automount-error.log');
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(agentsDir, `${label}.plist`);
  fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(scriptPath, buildAutoMountScript(mounts), { encoding: 'utf-8', mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  fs.writeFileSync(
    plistPath,
    buildLaunchAgentPlist({ label, scriptPath, stdoutPath, stderrPath }),
    { encoding: 'utf-8', mode: 0o600 }
  );
  fs.chmodSync(plistPath, 0o600);

  // Run once synchronously. A partial failure must not prevent installing the retry job;
  // keep a redacted warning while successfully mounted shares remain available.
  let firstRunError = '';
  try {
    runCmd('/bin/sh', [scriptPath], { timeout: Math.max(30000, mounts.length * 15000) });
  } catch (e) {
    firstRunError = String(e && e.message ? e.message : e);
    for (const mount of mounts) firstRunError = redactMountError(firstRunError, mount);
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  const domain = `gui/${uid}`;
  try {
    runCmd('/bin/launchctl', ['bootout', domain, plistPath]);
  } catch { /* first install / not loaded */ }
  runCmd('/bin/launchctl', ['bootstrap', domain, plistPath]);
  return { mode: 'launchagent', label, firstRunError };
}

/** 在触发认证/管理员弹窗前确认 SMB 服务可达，避免离线时反复要求用户输入密码。 */
function assertSmbReachable(host) {
  try {
    runCmd('/usr/bin/nc', ['-z', '-w', '3', host, '445'], { timeout: 5000 });
  } catch {
    throw new Error(
      `无法连接 Windows 主机 ${host}:445。请确认 Windows 电脑已开机、两台设备在同一局域网，` +
        '并在 Mac 端更新为 Windows 当前 IP；本次未进入密码认证。'
    );
  }
}

/** 手动挂载单个共享；凭据通过 spawn 参数传递，不启动 shell，也不触发交互密码框。 */
function mountOne(m, home) {
  const mp = m.mountPoint || path.join(home, 'Shared', m.shareName);
  if (IS_MAC) {
    const normalized = validateMount({ ...m, mountPoint: mp });
    const mountedNow = () => {
      try {
        return isMountPointMounted(runCmd('/sbin/mount', []), normalized.mountPoint);
      } catch {
        return false;
      }
    };
    // Repeated clicks are idempotent. Check before the network/authentication path so an
    // existing mount never turns into a misleading SMB/ACL failure.
    if (mountedNow()) return { mountPoint: mp, alreadyMounted: true };
    assertSmbReachable(normalized.host);
    runCmd('mkdir', ['-p', mp]);
    try {
      // Apple recommends the system mount command instead of invoking mount_smbfs directly.
      runCmd('/sbin/mount', ['-t', 'smbfs', buildSmbUrl(normalized), mp]);
    } catch (e) {
      // Cover a race with the LaunchAgent or another click between the pre-check and mount.
      if (mountedNow()) return { mountPoint: mp, alreadyMounted: true };
      const message = redactMountError(e, normalized);
      if (/Permission denied/i.test(message)) {
        throw new Error(
          `Windows 共享「${normalized.shareName}」拒绝访问（错误 64）。` +
            `请在 Windows 执行 Get-SmbShareAccess 检查共享级 ACL；账号应为 ` +
            `“Windows机器名\\${normalized.account}”对应的有效 Windows 用户，不能是“机器名\\”空用户名。`
        );
      }
      throw new Error(message);
    }
  } else {
    throw new Error('仅 macOS 支持挂载');
  }
  return { mountPoint: mp, alreadyMounted: false };
}

/** 卸载 */
function unmountPoint(mp) {
  if (IS_MAC) {
    const removeEmptyMountPoint = () => {
      if (!mp || path.parse(mp).root === mp) return false;
      try {
        fs.rmdirSync(mp); // 非递归：只有真正空目录才会删除，用户文件绝不会被清理
        return true;
      } catch (e) {
        if (e && ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EBUSY'].includes(e.code)) return false;
        throw e;
      }
    };
    try {
      runCmd('umount', [mp]);
      return { ok: true, mountPointRemoved: removeEmptyMountPoint() };
    } catch (e1) {
      try {
        runCmd('diskutil', ['unmount', 'force', mp]);
        return { ok: true, mountPointRemoved: removeEmptyMountPoint() };
      } catch (e2) {
        // 未挂载时给友好提示，不抛错
        const msg = String(e1.message || e1) + ' ' + String(e2.message || e2);
        if (/Unable to find disk|not currently mounted|not mounted|No such file/i.test(msg)) {
          return { ok: false, reason: 'not-mounted', mountPointRemoved: removeEmptyMountPoint() };
        }
        throw new Error(msg.trim());
      }
    }
  } else {
    throw new Error('仅 macOS 支持卸载');
  }
}

/** 获取本机局域网 IPv4（过滤虚拟网卡） */
function getLocalIPs() {
  const nets = os.networkInterfaces();
  const skipNames = /vmware|virtualbox|vethernet|veth|wsl|hyper-v|loopback|蓝牙|bluetooth/i;
  const out = [];
  for (const name of Object.keys(nets)) {
    if (skipNames.test(name)) continue;
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        out.push({ iface: name, ip: ni.address });
      }
    }
  }
  return out;
}

// ---------- IPC ----------

function registerIpc() {
  const credentialStore = createCredentialStore(path.join(DATA_DIR, 'trusted-devices.json'), { safeStorage });
  trustedCredentialStore = credentialStore;
  ipcMain.handle('transfer:info', () => ({ port: transferServer?.port || null, localOnly: false, host: transferServer?.host || '0.0.0.0', root: TRANSFER_DIR }));
  ipcMain.handle('transfer:requestChallenge', async (_e, input = {}) => { const host = String(input.host || ''); const port = Number(input.port || 7891); if (!host || !input.sessionId || !input.transferId || !input.senderId) return { ok: false, reasonCode: 'CHALLENGE_PARAMS_INVALID' }; try { const response = await globalThis.fetch(`http://${host}:${port}/api/pair/transfer-challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: input.sessionId, senderId: input.senderId, transferId: input.transferId }) }); const body = await response.json(); return response.ok ? body : { ok: false, reasonCode: 'CHALLENGE_REJECTED' }; } catch { return { ok: false, reasonCode: 'CHALLENGE_UNREACHABLE' }; } });
  ipcMain.handle('transfer:selectFile', async () => { const picked = await dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'], title: '选择要传输的文件或文件夹' }); if (picked.canceled || !picked.filePaths[0]) return null; const file = picked.filePaths[0]; const stat = fs.statSync(file); if (stat.isDirectory()) return { path: file, name: path.basename(file), kind: 'folder', size: 0, sha256: null }; const sha256 = await hashFile(file); return { path: file, name: path.basename(file), kind: 'file', size: stat.size, sha256 }; });
  ipcMain.handle('services:ports', () => normalizeServicePorts(loadSettings().servicePorts || {}));
  ipcMain.handle('services:setPorts', (_e, ports = {}) => { const normalized = normalizeServicePorts(ports); const settings = loadSettings(); settings.servicePorts = normalized; saveSettings(settings); return { ok: true, ports: normalized, restartRequired: true }; });
  ipcMain.handle('services:health', async () => {
    const ports = normalizeServicePorts({ transfer: transferServer?.port || DEFAULT_PORTS.transfer });
    const checkTcp = (port) => new Promise((resolve) => { const socket = net.createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.setTimeout(300, () => { socket.destroy(); resolve(false); }); });
    const checkUdp = (port) => new Promise((resolve) => { const socket = dgram.createSocket('udp4'); socket.once('listening', () => { socket.close(() => resolve(false)); }); socket.once('error', (error) => { socket.close(() => resolve(error.code === 'EADDRINUSE')); }); socket.bind(port, '127.0.0.1'); });
    const result = []; for (const [name, port] of Object.entries(ports)) { const check = RANGES[name] === 'udp' ? checkUdp : checkTcp; const occupied = await check(port); const expected = name === 'chat' ? Boolean(chatInfo?.port === port) : name === 'pairing' ? Boolean(pairingServer?.port === port) : name === 'transfer' ? Boolean(transferServer?.port === port) : false; const item = describePort(name, port, occupied, expected); if (occupied && !expected) { for (let candidate = port + 1; candidate < Math.min(port + 100, 65536); candidate += 1) { if (!(await check(candidate))) { item.suggestedPort = candidate; break; } } } result.push(item); } return { ports, services: result, checkedAt: new Date().toISOString() };
  });
  ipcMain.handle('pairing:pending', () => pairingServer?.pending?.() || []);
  ipcMain.handle('pairing:confirmIncoming', (_e, { sessionId, code } = {}) => { const result = pairingServer?.confirm?.(sessionId, code) || { ok: false, reasonCode: 'PAIRING_SERVICE_UNAVAILABLE' }; if (result.ok) credentialStore.set(result.remoteDeviceId, JSON.stringify({ authorization: result.authorization, fingerprint: result.remoteFingerprint, publicKey: result.remotePublicKey || '' })); return result; });
  ipcMain.handle('pairing:rejectIncoming', (_e, { sessionId } = {}) => pairingServer?.reject?.(sessionId) || { ok: false, reasonCode: 'PAIRING_SERVICE_UNAVAILABLE' });
  ipcMain.handle('pairing:unpair', (_e, { deviceId } = {}) => { if (!deviceId) return { ok: false, reasonCode: 'DEVICE_ID_REQUIRED' }; credentialStore.remove(String(deviceId)); return { ok: true }; });
  ipcMain.handle('pairing:request', async (_e, remote = {}) => {
    const identity = loadOrCreateIdentity(path.join(DATA_DIR, 'device.json'), { platform: PLATFORM, deviceName: os.hostname() });
    const host = String(remote.network?.preferredAddress || ''); const port = Number(remote.services?.pairing?.port || 7891);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reasonCode: 'REMOTE_ENDPOINT_INVALID' };
    try { const response = await globalThis.fetch(`http://${host}:${port}/api/pair/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromDeviceId: identity.deviceId, fromDeviceName: identity.deviceName, fromFingerprint: identity.identity?.fingerprint || identity.deviceId, fromPublicKey: identity.identity?.publicKey || '', toDeviceId: String(remote.deviceId || '') }) }); const body = await response.json(); return response.ok ? { ok: true, ...body, host, port } : { ok: false, reasonCode: 'REMOTE_REJECTED' }; } catch { return { ok: false, reasonCode: 'REMOTE_UNREACHABLE' }; }
  });
  ipcMain.handle('pairing:status', async (_e, session = {}) => { try { const response = await globalThis.fetch(`http://${session.host}:${session.port}/api/pair/status/${encodeURIComponent(session.sessionId)}`); const body = await response.json(); if (response.ok && body.state === 'accepted' && session.remoteDeviceId) credentialStore.set(session.remoteDeviceId, JSON.stringify({ authorization: body.authorization || null, fingerprint: body.identityFingerprint || '', pairedAt: new Date().toISOString() })); return response.ok ? { ok: true, ...body } : { ok: false, reasonCode: 'STATUS_UNAVAILABLE' }; } catch { return { ok: false, reasonCode: 'REMOTE_UNREACHABLE' }; } });
  let discoveryService = null;
  ipcMain.handle('discovery:list', async () => {
    await startTransfer();
    const identity = loadOrCreateIdentity(path.join(DATA_DIR, 'device.json'), { platform: PLATFORM, platformVersion: os.release(), deviceType: IS_WIN ? 'desktop' : 'laptop', deviceName: os.hostname(), network: { addresses: getLocalIPs().map((n) => ({ address: n.ip, interfaceName: n.iface, family: 'IPv4' })) }, config: {}, services: { chat: IS_WIN, pairing: { port: 7891 }, transfer: { port: transferServer?.port || 49152 } }, trusted: false });
    const local = buildLocalDevice(identity);
    if (!discoveryService) discoveryService = startDiscovery(local, { port: normalizeServicePorts(loadSettings().servicePorts || {}).discovery });
    return discoveryService.list().map((device) => { try { const saved = JSON.parse(credentialStore.get(device.deviceId) || '{}'); if (!saved.fingerprint) return device; return { ...device, trust: { ...device.trust, state: saved.fingerprint === device.identity?.fingerprint ? 'trusted' : 'identity_changed' } }; } catch { return device; } });
  });
  ipcMain.handle('device:info', () => {
    const identity = loadOrCreateIdentity(path.join(DATA_DIR, 'device.json'), {
      platform: PLATFORM, platformVersion: os.release(), deviceType: IS_WIN ? 'desktop' : 'laptop',
      deviceName: os.hostname(), config: {}, services: { chat: IS_WIN, pairing: { port: 7891 }, transfer: { port: transferServer?.port || 49152 } }, trusted: false,
    });
    return buildLocalDevice(identity);
  });
  // 系统信息
  ipcMain.handle('sys:info', () => ({
    platform: PLATFORM,
    hostname: os.hostname(),
    username: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })(),
    ips: getLocalIPs(),
    isAdmin: isAdmin(),
    home: os.homedir(),
  }));

  // 目录选择
  ipcMain.handle('dialog:selectFolder', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择要共享的文件夹',
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---- 共享管理（Windows） ----
  ipcMain.handle('share:list', () => loadShares());

  ipcMain.handle('share:add', (e, payload) => {
    let diagnosticDirPath = '';
    try {
    // 入口提权守卫：非管理员直接抛带 code 的错误，前端按 code 精确判断
    // （不再依赖 icacls/net share 的 stderr 文本，避免把"路径/ACL 等拒绝访问"误判为非管理员）
    if (IS_WIN && !isAdmin()) {
      logEvent('warn', 'share', '新建共享被拒：当前进程非管理员');
      const err = new Error('需要管理员权限');
      err.code = 'NEED_ADMIN';
      throw err;
    }
    const {
      dirPath: rawDirPath,
      shareName,
      account,
      password,
      unified,
    } = payload || {};
    // 防御：去除首尾空白（含全角空格 U+3000）。手动输入路径时极易误带尾随空格，
    // 会导致 fs.existsSync 直接 false 而报"文件夹不存在"；裁剪后大概率能命中真实路径。
    const dirPath = String(rawDirPath == null ? '' : rawDirPath).replace(
      /^[\s\u3000]+|[\s\u3000]+$/g,
      ''
    );
    diagnosticDirPath = dirPath;
    const dirPathTrimChanged = dirPath !== String(rawDirPath == null ? '' : rawDirPath);
    if (!dirPath || !fs.existsSync(dirPath)) {
      // 区分"路径不存在"和"路径存在但当前进程无访问权限"（ACL 拒绝时 existsSync 也返回 false）
      let accessCode = null;
      try {
        fs.accessSync(dirPath, fs.constants.R_OK);
      } catch (e) {
        accessCode = e && e.code ? e.code : null;
      }
      // 诊断：同时输出 raw（原始）与 dirPath（裁剪后）的字符码位，便于区分
      // "路径本身乱码"还是"输入误带空白/不可见字符"
      const esc = (s) =>
        s
          ? Array.from(s)
              .map((c) =>
                c.charCodeAt(0) > 127
                  ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
                  : c
              )
              .join('')
          : s;
      logEvent(
        'warn',
        'share',
        `路径诊断: raw=${JSON.stringify(rawDirPath)} dirPath=${JSON.stringify(dirPath)} ` +
          `rawLen=${rawDirPath ? rawDirPath.length : 0} len=${dirPath.length} ` +
          `trimChanged=${dirPathTrimChanged} accessCode=${accessCode} ` +
          `esc=${esc(dirPath).slice(0, 200)} fs.existsSync=false`
      );
      if (accessCode === 'EACCES' || accessCode === 'EPERM') {
        throw new Error(
          `文件夹无访问权限（ACL 被拒绝）: ${dirPath}。` +
            '请在资源管理器里右键该文件夹 → 属性 → 安全 → 高级 → 修改所有者/权限，' +
            '或用 PowerShell 执行 takeown + icacls 修复。'
        );
      }
      throw new Error('文件夹不存在: ' + dirPath);
    }
    if (!fs.statSync(dirPath).isDirectory()) throw new Error('不是文件夹: ' + dirPath);
    assertLocalPath(dirPath);

    const shares = loadShares();
    // 共享名统一清洗（用户手动输入也可能含非法字符）
    const finalShare = cleanShareName(shareName || toShareName(dirPath));
    if (shares.some((s) => s.shareName === finalShare)) {
      throw new Error(`共享名 "${finalShare}" 已存在`);
    }

    // 统一账号模式：所有共享共用当前 Windows 登录账号，不新建账号、删除时不删登录账号
    const isUnified = !!unified;
    let finalAccount;
    let finalPassword;
    let autoAccount = false;
    finalAccount = String(account || '').trim();
    finalPassword = String(password || '').trim();
    verifyUserCredentials(finalAccount, finalPassword);
    let grantWarnings = [];
    try {
      grantWarnings = grantDir(dirPath, finalAccount);
      createShare(finalShare, dirPath, finalAccount);
    } catch (e) {
      // 回滚：仅当本次新建了账号（用户未指定已有账号）时删除，避免孤儿账号残留
      if (autoAccount) {
        try {
          runCmd('net', ['user', finalAccount, '/delete']);
        } catch { /* 忽略 */ }
      }
      throw e;
    }
    // 记录 grantDir 的降级步骤（不阻断共享，但要让用户在日志里看到）
    grantWarnings.forEach((w) => logEvent('warn', 'share', w));

    const item = {
      id: crypto.randomUUID(),
      dirPath,
      shareName: finalShare,
      account: finalAccount,
      password: finalPassword,
      autoAccount,
      unified: isUnified,
      createdAt: new Date().toISOString(),
    };
    shares.push(item);
    saveShares(shares);
    ssh.syncManifest(shares);
    logEvent('info', 'share', `新建共享「${finalShare}」${isUnified ? '（统一账号模式）' : ''}`);
    return item;
    } catch (err) {
      logEvent('error', 'share', '新建共享失败: ' + (err.message || err));
      // 当错误像"系统错误 5 / 拒绝访问"时，自动对该目录跑一次 ACL 诊断
      if (/系统错误 5|拒绝访问|denied|denied\.|access is denied/i.test(err.message || '')) {
        logEvent('info', 'share', diagnoseShareAccess(diagnosticDirPath));
      }
      throw err;
    }
  });

  ipcMain.handle('share:remove', (e, id) => {
    try {
      const shares = loadShares();
      const idx = shares.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error('共享不存在');
      const s = shares[idx];
      removeShare(s.shareName);
      // 自动生成的账号一并删除，手动指定的保留
      if (s.autoAccount) removeUser(s.account);
      shares.splice(idx, 1);
      saveShares(shares);
      ssh.syncManifest(shares);
      logEvent('info', 'share', `删除共享「${s.shareName}」`);
      return shares;
    } catch (err) {
      logEvent('error', 'share', '删除共享失败: ' + (err.message || err));
      throw err;
    }
  });

  ipcMain.handle('share:resetPassword', (e, { id, password }) => {
    try {
      const shares = loadShares();
      const s = shares.find((x) => x.id === id);
      if (!s) throw new Error('共享不存在');
      if (s.unified) {
        logEvent('warn', 'share', `统一账号模式不支持重置密码，已拒绝：共享「${s.shareName}」`);
        throw new Error('统一账号模式不支持重置密码（会修改当前 Windows 登录密码）');
      }
      const newPwd = password || genPassword();
      runCmd('net', ['user', s.account, newPwd]);
      s.password = newPwd;
      saveShares(shares);
      ssh.syncManifest(shares);
      logEvent('info', 'share', `重置共享「${s.shareName}」密码`);
      return s;
    } catch (err) {
      logEvent('error', 'share', '重置共享密码失败: ' + (err.message || err));
      throw err;
    }
  });

  ipcMain.handle('share:gen', () => ({ account: genAccount(), password: genPassword() }));
  ipcMain.handle('share:getSettings', () => loadSettings());
  ipcMain.handle('share:setSettings', (e, s) => {
    saveSettings(s || {});
    return loadSettings();
  });

  // 统一账号模式：把当前 Windows 登录密码同步到所有 unified 共享的内部记录
  // （仅更新本工具保存的副本，真正的系统登录密码由用户在 Windows 内修改）
  ipcMain.handle('share:syncUnifiedPassword', (e, { password } = {}) => {
    try {
      const pwd = (password || '').trim();
      if (!pwd) throw new Error('请提供新的登录密码');
      const shares = loadShares();
      let updated = 0;
      for (const s of shares) {
        if (s.unified) {
          s.password = pwd;
          updated++;
        }
      }
      if (updated === 0) throw new Error('当前没有「统一账号模式」的共享，无需同步');
      saveShares(shares);
      ssh.syncManifest(shares);
      logEvent('info', 'share', `已同步 ${updated} 个统一账号共享的密码`);
      return { updated, shares };
    } catch (err) {
      logEvent('error', 'share', '同步统一账号密码失败: ' + (err.message || err));
      throw err;
    }
  });

  // 统一账号模式：把存量「非统一账号」共享迁移到当前 Windows 登录账号
  ipcMain.handle('share:migrateToUnified', (e, { password } = {}) => {
    try {
      const pwd = (password || '').trim();
      if (!pwd) throw new Error('请提供当前 Windows 登录密码');
      const username = os.userInfo().username;
      const shares = loadShares();
      const results = [];
      for (const s of shares) {
        if (s.unified) {
          results.push({ shareName: s.shareName, status: 'skip' });
          continue;
        }
      const oldAccount = s.account;
      try {
        if (IS_WIN) {
          const ws = grantDir(s.dirPath, username); // 以登录账号授权 + 确保继承开启（含自愈：修复历史上被 /inheritance:r 破坏过的目录）
          ws.forEach((w) => logEvent('warn', 'share', `迁移「${s.shareName}」: ${w}`));
          if (oldAccount && oldAccount !== username) {
            revokeDirFromAccount(s.dirPath, oldAccount); // 清理旧账号 ACE
          }
          removeShare(s.shareName); // 共享级授权绑定账号，需以登录账号重建
          createShare(s.shareName, s.dirPath, username);
          if (s.autoAccount && oldAccount && oldAccount !== username) {
            removeUser(oldAccount); // 仅删除自动生成的旧专属账号
          }
        }
        s.account = username;
        s.password = pwd;
        s.unified = true;
        s.autoAccount = false;
        results.push({ shareName: s.shareName, status: 'ok' });
      } catch (err) {
        logEvent('error', 'share', `迁移「${s.shareName}」到统一账号失败: ${err.message || err}`);
        results.push({ shareName: s.shareName, status: 'error', reason: String(err.message || err) });
      }
      }
      saveShares(shares);
      ssh.syncManifest(shares);
      const ok = results.filter((r) => r.status === 'ok').length;
      const fail = results.filter((r) => r.status === 'error').length;
      logEvent('info', 'share', `迁移到统一账号完成: 成功 ${ok}，失败 ${fail}，跳过 ${results.length - ok - fail}`);
      return { results, shares };
    } catch (err) {
      logEvent('error', 'share', '迁移到统一账号失败: ' + (err.message || err));
      throw err;
    }
  });

  // ---- SSH 免密通道 ----
  // 脚本放 Temp 下无中文无空格的路径（PowerShell 5.1 按 GBK 解析无 BOM 的 UTF-8 脚本，
  // 中文注释+中文路径的组合会导致脚本解析失败）
  const scriptsDir = path.join(os.tmpdir(), 'inner-net-scripts');
  try { fs.mkdirSync(scriptsDir, { recursive: true }); } catch { /* ignore */ }

  ipcMain.handle('ssh:status', () => ssh.getSshStatus());
  ipcMain.handle('ssh:enable', () => {
    try {
      const r = ssh.sshEnable(scriptsDir);
      logEvent('info', 'ssh', 'OpenSSH Server 已启用' + (r.running ? '，服务运行中' : ''));
      return r;
    } catch (err) {
      logEvent('error', 'ssh', '启用 OpenSSH Server 失败: ' + (err.message || err));
      throw err;
    }
  });
  ipcMain.handle('ssh:control', (e, action) => {
    try {
      const r = ssh.sshControl(scriptsDir, action);
      logEvent('info', 'ssh', `SSH 服务已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '操作'}`);
      return r;
    } catch (err) {
      logEvent('error', 'ssh', `SSH 服务${action}失败: ${err.message || err}`);
      throw err;
    }
  });
  ipcMain.handle('ssh:setPort', (e, port) => {
    try {
      const r = ssh.sshSetPort(scriptsDir, port);
      logEvent('info', 'ssh', `SSH 端口已设为 ${port}`);
      return r;
    } catch (err) {
      logEvent('error', 'ssh', '修改 SSH 端口失败: ' + (err.message || err));
      throw err;
    }
  });
  ipcMain.handle('ssh:addKey', (e, pubkey) => {
    try {
      const r = ssh.sshAddKey(scriptsDir, pubkey);
      logEvent('info', 'ssh', '已授权公钥');
      return r;
    } catch (err) {
      logEvent('error', 'ssh', '授权公钥失败: ' + err.message);
      throw err;
    }
  });
  ipcMain.handle('ssh:listKeys', () => {
    try {
      return ssh.sshListKeys();
    } catch (err) {
      logEvent('error', 'ssh', '读取公钥列表失败: ' + err.message);
      throw err;
    }
  });
  ipcMain.handle('ssh:removeKey', (e, line) => {
    try {
      const r = ssh.sshRemoveKey(scriptsDir, line);
      logEvent('info', 'ssh', '已删除公钥');
      return r;
    } catch (err) {
      logEvent('error', 'ssh', '删除公钥失败: ' + err.message);
      throw err;
    }
  });
  ipcMain.handle('ssh:manifestReady', () => {
    try {
      return fs.existsSync(ssh.MANIFEST_FILE);
    } catch {
      return false;
    }
  });
  ipcMain.handle('ssh:key', () => ssh.getOrCreateKey());
  ipcMain.handle('ssh:pull', (e, { host, user, port }) => {
    logEvent('info', 'ssh', `拉取共享清单: ${user}@${host}:${port || 22}`);
    try {
      const r = ssh.sshPull(host, user, port);
      logEvent('info', 'ssh', `拉取成功，${(r || []).length} 个共享`);
      return r;
    } catch (err) {
      logEvent('error', 'ssh', '拉取清单失败: ' + err.message);
      throw err;
    }
  });

  // ---- 运行日志 ----
  ipcMain.handle('log:history', () => logBuffer.slice());

  // ---- 挂载管理（macOS） ----
  ipcMain.handle('mount:list', () => loadMounts());

  ipcMain.handle('mount:save', (e, mounts) => {
    saveMounts(mounts);
    return loadMounts();
  });

  ipcMain.handle('mount:applyAutofs', async (e, mounts) => {
    try {
      const home = os.homedir();
      const normalized = (mounts || loadMounts()).map((m) => ({
        ...m,
        mountPoint: m.mountPoint || path.join(home, 'Shared', m.shareName),
      }));
      const body = applyAutofs(normalized);
      let mountOutput = '';
      try { mountOutput = runCmd('/sbin/mount', []); } catch { /* ignore status probe */ }
      const mounted = normalized
        .filter((m) => isMountPointMounted(mountOutput, m.mountPoint))
        .map((m) => m.shareName);
      const pending = normalized.filter((m) => !mounted.includes(m.shareName)).map((m) => m.shareName);
      saveMounts(normalized);
      if (body.firstRunError) {
        logEvent('warn', 'mount', `自动挂载部分失败（后台将重试）: ${body.firstRunError}`);
      }
      logEvent('info', 'mount', `应用 autofs 配置，${normalized.length} 个共享`);
      return { autoSmb: body, mounts: normalized, mounted, pending };
    } catch (err) {
      logEvent('error', 'mount', '应用 autofs 配置失败: ' + (err.message || err));
      throw err;
    }
  });

  ipcMain.handle('mount:mountOne', (e, mount) => {
    try {
      const home = os.homedir();
      const result = mountOne({ ...mount, password: mount.password || undefined }, home);
      if (result.alreadyMounted) {
        logEvent('info', 'mount', `「${mount.shareName}」已经挂载，无需重复操作`);
      } else {
        logEvent('info', 'mount', `挂载「${mount.shareName}」→ ${result.mountPoint}`);
      }
      return result;
    } catch (err) {
      logEvent('error', 'mount', `挂载「${mount && mount.shareName}」失败: ${err.message || err}`);
      throw err;
    }
  });

  ipcMain.handle('mount:unmount', (e, mountPoint) => {
    try {
      const result = unmountPoint(mountPoint);
      logEvent('info', 'mount', `卸载 ${mountPoint}`);
      return result;
    } catch (err) {
      logEvent('error', 'mount', `卸载 ${mountPoint} 失败: ${err.message || err}`);
      throw err;
    }
  });

  // ---- 群聊 ----
  ipcMain.handle('chat:info', () => ({
    port: chatInfo?.port || 0,
    url: chatInfo?.url || '',
    lanUrl: chatInfo
      ? `http://${getLocalIPs()[0]?.ip || '局域网IP'}:${chatInfo.port}/`
      : '',
    online: chatInfo?.online() || 0,
  }));
  ipcMain.handle('chat:storageStats', () => {
    if (!IS_WIN) throw new Error('聊天记录管理仅在 Windows 共享端可用');
    return {
      ...storageStats({
      messagesFile: CHAT_MESSAGES_FILE,
      imagesDir: CHAT_IMAGES_DIR,
      filesDir: CHAT_FILES_DIR,
      messages: chatInfo?.messages || [],
      }),
      locations: { dataDir: DATA_DIR, messagesFile: CHAT_MESSAGES_FILE, imagesDir: CHAT_IMAGES_DIR, filesDir: CHAT_FILES_DIR },
    };
  });
  ipcMain.handle('chat:clearStorage', (_e, scope) => {
    if (!IS_WIN) throw new Error('聊天记录管理仅在 Windows 共享端可用');
    const result = clearChatStorage({
      scope,
      messagesFile: CHAT_MESSAGES_FILE,
      imagesDir: CHAT_IMAGES_DIR,
      filesDir: CHAT_FILES_DIR,
      messages: chatInfo?.messages || [],
    });
    if (scope === 'messages' || scope === 'all') chatInfo?.broadcastEvent('reset', { reason: scope });
    logEvent('info', 'chat', `聊天缓存清理完成: ${scope}，删除 ${result.removedFiles} 个文件`);
    return {
      ...result,
      stats: {
        ...result.stats,
        locations: { dataDir: DATA_DIR, messagesFile: CHAT_MESSAGES_FILE, imagesDir: CHAT_IMAGES_DIR, filesDir: CHAT_FILES_DIR },
      },
    };
  });
  ipcMain.handle('chat:export', (_e, options = {}) => {
    if (!IS_WIN) throw new Error('仅 Windows 共享端支持导出');
    const from = Number(options.from) || 0; const to = Number(options.to) || Infinity;
    const list = (chatInfo?.messages || []).filter((m) => m.ts >= from && m.ts <= to);
    if (options.format === 'md') return `# 群聊记录\n\n${list.map((m) => `- ${new Date(m.ts).toLocaleString('zh-CN')} **${m.nick}**：${m.text || (m.file ? `[文件] ${m.file.name}` : '[图片]')}`).join('\n')}`;
    return JSON.stringify(list, null, 2);
  });
  ipcMain.handle('chat:deleteMessages', (_e, ids) => {
    if (!IS_WIN || !Array.isArray(ids)) throw new Error('参数无效');
    return { count: chatInfo?.deleteMessages?.(ids) || 0 };
  });
}

let chatInfo = null;
let pairingServer = null;
let transferServer = null;
let trustedCredentialStore = null;

async function startTransfer() {
  if (transferServer) return transferServer;
  const configured = normalizeServicePorts(loadSettings().servicePorts || {});
  transferServer = await startTransferServer({ port: configured.transfer, root: TRANSFER_DIR, verifyOfferChallenge: (signed, manifest) => { try { if (!manifest.senderPublicKey) return false; return require('../core/transfer').verifyTransferChallenge(signed, crypto.createPublicKey(manifest.senderPublicKey), { senderId: manifest.senderId, receiverId: loadOrCreateIdentity(path.join(DATA_DIR, 'device.json'), {}).deviceId, transferId: manifest.transferId }); } catch { return false; } } });
  logEvent('info', 'transfer', `原生传输服务已启动（等待受认证传输会话）：${transferServer.host}:${transferServer.port}`);
  return transferServer;
}

async function startPairing() {
  if (pairingServer) return pairingServer;
  const identity = loadOrCreateIdentity(path.join(DATA_DIR, 'device.json'), { platform: PLATFORM, platformVersion: os.release(), deviceType: IS_WIN ? 'desktop' : 'laptop', deviceName: os.hostname(), config: {}, services: { chat: IS_WIN, pairing: { port: 7891 } }, trusted: false });
  pairingServer = await startPairingServer({
    port: normalizeServicePorts(loadSettings().servicePorts || {}).pairing, deviceId: identity.deviceId, identityFingerprint: identity.identity?.fingerprint || '', privateKey: fs.readFileSync(path.join(DATA_DIR, 'device.json.private.pem'), 'utf8'),
    onRequest: (request) => { logEvent('info', 'pairing', `收到 ${request.fromDeviceName} 的配对请求`); mainWindow?.webContents.send('pairing:incoming', request); },
  });
  logEvent('info', 'pairing', `配对服务已启动：${pairingServer.port}`);
  return pairingServer;
}

function startChat() {
  // Windows 共享端才启动聊天服务
  if (!IS_WIN) return;
  startChatServer(normalizeServicePorts(loadSettings().servicePorts || {}).chat, {
    file: CHAT_MESSAGES_FILE,
    imagesDir: CHAT_IMAGES_DIR,
    filesDir: CHAT_FILES_DIR,
    onEvent: (e) => logEvent(e.level, e.source, e.message),
    shareManifest: () => loadShares(),
  })
    .then((info) => {
      chatInfo = info;
      const ip = getLocalIPs()[0]?.ip || '局域网IP';
      logEvent('info', 'chat', `群聊服务（会话）已启动: http://${ip}:${info.port}/ (本机 http://127.0.0.1:${info.port}/)`);
    })
    .catch((err) => {
      logEvent('error', 'chat', '群聊服务（会话）启动失败: ' + err.message);
    });
}

// ---------- 窗口 ----------

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: 'InnerNet 内网共享',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1419' : '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;

  // Electron 44 的渲染进程不一定提供系统右键菜单；为所有可编辑控件补齐剪切/复制/粘贴。
  win.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return;
    event.preventDefault();
    Menu.buildFromTemplate([
      { label: '撤销', role: 'undo', enabled: params.editFlags.canUndo },
      { label: '重做', role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]).popup({ window: win });
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ---------- 启动 ----------

app.whenReady().then(() => {
  logEvent('info', 'app', `应用启动 (平台=${PLATFORM}${IS_WIN ? (isAdmin() ? '，管理员' : '，普通权限') : ''})`);
  // 非管理员仍允许打开界面查看状态，但高权限操作会被 IPC 守卫拒绝，前端显示红色权限提示。
  if (IS_WIN && !isAdmin()) logEvent('warn', 'app', '当前普通权限运行，高权限共享功能受限');
  registerIpc();
  startChat();
  startPairing().catch((err) => logEvent('warn', 'pairing', '配对服务启动失败: ' + err.message));
  startTransfer().catch((err) => logEvent('warn', 'transfer', '原生传输服务启动失败: ' + err.message));
  createWindow();
  logEvent('info', 'app', '主窗口已创建');

  // 确保 SSH 公钥托管文件存在且 ACL 正确（延迟执行，不阻塞 UI）
  setTimeout(() => {
    try {
      ssh.ensureAuthFile(SCRIPTS_DIR);
    } catch (e) {
      logEvent('warn', 'ssh', '确保公钥托管文件失败（非管理员时忽略）: ' + e.message);
    }
  }, 1500);

  // 启动自愈：修复历史遗留的共享目录 ACL 损坏（一次性，延迟执行不阻塞 UI）
  setTimeout(() => {
    try {
      healExistingShareAcls();
    } catch (e) {
      logEvent('error', 'share', `启动自愈调用异常: ${e.message}`);
    }
  }, 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
