/**
 * SSH 免密通道模块
 * Windows 端：OpenSSH Server 启用 / 公钥授权 / 共享清单同步（供 Mac 免密拉取）
 * macOS 端：生成密钥 / 通过 ssh 拉取 Windows 共享清单
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const MANIFEST_DIR = 'C:\\ProgramData\\inner-net'; // Windows 端免密清单目录（无空格路径）
// 直接用 Windows 反斜杠拼接，避免 path.join 在 macOS 上混入正斜杠导致 Windows cmd 报「命令语法不正确」
const MANIFEST_FILE = MANIFEST_DIR + '\\shares.json';
// 应用托管的公钥文件：sshd_config 的 AuthorizedKeysFile 指向此处，认证时 sshd 直接读它
const SSH_AUTH_KEYS = 'C:\\ProgramData\\inner-net\\authorized_keys';
const SSH_PORT = 2222; // 22 被 VMware NAT 占用，SSH 服务用 2222

function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 30000, ...opts });
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || '').trim() || `命令失败(${cmd})`);
  }
  return (res.stdout || '').trim();
}

/** 是否已提权（管理员令牌） */
function isElevated() {
  if (!IS_WIN) return true;
  try {
    require('child_process').execFileSync('net', ['session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行提权脚本：
 * - 已提权（管理员运行的应用）：直接 spawnSync 执行，输出可见、最可靠
 * - 未提权：Start-Process -Verb RunAs 弹 UAC（注意：Start-Process 不返回子进程输出，调用方应验证结果状态）
 */
function execElevated(scriptPath, argFile) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  if (argFile) args.push('-ArgFile', argFile);
  if (isElevated()) {
    const r = spawnSync('powershell.exe', args, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 600000,
    });
    if (r.error) throw new Error(r.error.message);
    return (r.stdout || '') + (r.stderr || '');
  }
  // 未提权：单层 UAC（数组形式传参，避免引号被破坏）
  const argStr = args.map((a) => `"${a}"`).join(',');
  const cmd = `Start-Process powershell -ArgumentList @(${argStr}) -Verb RunAs -Wait`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 600000,
  });
  if (r.error) throw new Error(r.error.message);
  return (r.stdout || '') + (r.stderr || '');
}

/** 写脚本文件（自动确保目录存在） */
function writeScript(scriptsDir, name, content) {
  fs.mkdirSync(scriptsDir, { recursive: true });
  const p = path.join(scriptsDir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ---------- Windows 端 ----------

function getSshStatus() {
  if (!IS_WIN) return { installed: false, running: false, port: SSH_PORT };
  let installed = false;
  let running = false;
  try {
    if (fs.existsSync(path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'sshd.exe'))) {
      installed = true;
    }
  } catch { /* ignore */ }
  try {
    const out = runCmd('sc', ['query', 'sshd']);
    running = /STATE\s*:\s*4\s+RUNNING/i.test(out);
  } catch { /* 服务不存在 */ }
  // 读取当前配置端口（从 sshd_config 的 Port 行）
  let port = SSH_PORT;
  try {
    const cfg = fs.readFileSync('C:\\ProgramData\\ssh\\sshd_config', 'utf-8');
    const m = cfg.match(/^\s*Port\s+(\d+)/m);
    if (m) port = Number(m[1]);
  } catch { /* 配置不存在用默认 */ }
  return { installed, running, port };
}

const CTRL_SCRIPT = (action) => `$ErrorActionPreference = 'Continue'
sc.exe config sshd start= auto | Out-Null
net ${action} sshd
Write-Output 'CTRL_${action.toUpperCase()}_DONE'
`;

const SETPORT_SCRIPT = `param([string]$ArgFile)
$ErrorActionPreference = 'Continue'
$Port = (Get-Content $ArgFile -Raw).Trim()
$cfg = "$env:ProgramData\\ssh\\sshd_config"
$lines = @(Get-Content $cfg) | Where-Object { $_ -notmatch '^\\s*Port\\s' }
Set-Content $cfg (@("Port $Port") + $lines) -Encoding ascii
sc.exe config sshd start= auto | Out-Null
Restart-Service sshd -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if ((Get-Service sshd).Status -ne 'Running') { net start sshd }
Write-Output 'PORT_SET'
`;

/** 启动/停止 SSH 服务（提权） */
function sshControl(scriptsDir, action) {
  const p = writeScript(scriptsDir, `ssh-${action}.ps1`, CTRL_SCRIPT(action));
  execElevated(p);
  return getSshStatus();
}

/** 修改 SSH 端口并重启服务（提权） */
function sshSetPort(scriptsDir, port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口须为 1-65535 的整数');
  const portFile = path.join(scriptsDir, 'sshport.tmp');
  fs.writeFileSync(portFile, String(n), 'utf-8');
  const p = writeScript(scriptsDir, 'ssh-setport.ps1', SETPORT_SCRIPT);
  execElevated(p, portFile);
  return getSshStatus();
}

const SETUP_SCRIPT = `$ErrorActionPreference = 'Stop'
$cap = Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
}
# config Port 2222 (22 occupied by VMware NAT; Port must be at file start, not inside Match block)
New-Item -ItemType Directory -Force -Path "$env:ProgramData\\ssh" | Out-Null
$cfg = "$env:ProgramData\\ssh\\sshd_config"
if (Test-Path $cfg) {
  $lines = @(Get-Content $cfg) | Where-Object { $_ -notmatch '^\\s*Port\\s' }
  Set-Content $cfg (@('Port 2222') + $lines) -Encoding ascii
} else {
  Set-Content $cfg 'Port 2222' -Encoding ascii
}
sc.exe config sshd start= auto | Out-Null
net start sshd
# firewall: allow 2222
New-NetFirewallRule -DisplayName 'OpenSSH Server (sshd)' -Direction Inbound -Protocol TCP -LocalPort 2222 -Action Allow -ErrorAction SilentlyContinue | Out-Null
# manifest dir
New-Item -ItemType Directory -Force -Path C:\\ProgramData\\inner-net | Out-Null
Write-Output 'SSH_READY'
`;

const ADDKEY_SCRIPT = `param([string]$ArgFile)
$ErrorActionPreference = 'Stop'
$Key = (Get-Content $ArgFile -Raw).Trim()
if (-not $Key) { Write-Error 'EMPTY_KEY'; exit 1 }
# app-managed authorized keys file (sshd_config AuthorizedKeysFile points here)
$f = 'C:\\ProgramData\\inner-net\\authorized_keys'
New-Item -ItemType Directory -Force -Path 'C:\\ProgramData\\inner-net' | Out-Null
if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f -Force | Out-Null }
$existing = Get-Content $f -Raw -ErrorAction SilentlyContinue
if (-not ($existing -and $existing.Contains($Key))) {
  Add-Content -Path $f -Value "$Key\`n" -Encoding ascii
  # grant first, then /inheritance:r (reverse order locks the file)
  icacls $f /grant 'SYSTEM:(F)' /grant 'Administrators:(F)' | Out-Null
  icacls $f /inheritance:r | Out-Null
}
Write-Output 'KEY_ADDED'
`;

const REMOVEKEY_SCRIPT = `param([string]$ArgFile)
$ErrorActionPreference = 'Continue'
$Line = (Get-Content $ArgFile -Raw).Trim()
$f = 'C:\\ProgramData\\inner-net\\authorized_keys'
if (-not (Test-Path $f)) { Write-Output 'KEY_REMOVED'; exit 0 }
$lines = @(Get-Content $f) | Where-Object { $_.Trim() -ne $Line }
Set-Content $f $lines -Encoding ascii
Write-Output 'KEY_REMOVED'
`;

/** 启用 OpenSSH Server（提权） */
function sshEnable(scriptsDir) {
  const p = writeScript(scriptsDir, 'ssh-setup.ps1', SETUP_SCRIPT);
  execElevated(p);
  // 以真实服务状态为准，避免 OpenSSH 已就绪时误报失败
  return getSshStatus().running;
}

/** 读取已授权公钥列表：[{line, type, key, comment}] */
function sshListKeys() {
  try {
    const content = fs.readFileSync(SSH_AUTH_KEYS, 'utf-8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return {
          line: l,
          type: parts[0] || '',
          key: parts[1] || '',
          comment: parts.slice(2).join(' ') || '',
        };
      });
  } catch {
    return [];
  }
}

/** 从应用托管公钥文件删除指定公钥行（提权） */
function sshRemoveKey(scriptsDir, line) {
  const target = String(line || '').trim();
  if (!target) throw new Error('缺少要删除的公钥');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const lineFile = path.join(scriptsDir, 'rmkey.tmp');
  fs.writeFileSync(lineFile, target + '\n', 'utf-8');
  const p = writeScript(scriptsDir, 'ssh-rmkey.ps1', REMOVEKEY_SCRIPT);
  execElevated(p, lineFile);
  return true;
}

/** 确保应用托管公钥文件存在且 ACL 正确（提权，启动时调用） */
function ensureAuthFile(scriptsDir) {
  if (!IS_WIN) return;
  try {
    fs.mkdirSync(scriptsDir, { recursive: true });
    const p = writeScript(
      scriptsDir,
      'ssh-ensure.ps1',
      `New-Item -ItemType Directory -Force -Path 'C:\\ProgramData\\inner-net' | Out-Null
$f = 'C:\\ProgramData\\inner-net\\authorized_keys'
if (-not (Test-Path $f)) { New-Item -ItemType File -Path $f -Force | Out-Null }
icacls $f /grant 'SYSTEM:(F)' /grant 'Administrators:(F)' | Out-Null
icacls $f /inheritance:r | Out-Null
Write-Output 'OK'`
    );
    execElevated(p);
  } catch { /* 非管理员时忽略，授权操作时再确保 */ }
}

/** 授权公钥（提权）；返回 true=已写入，抛错=授权失败 */
function sshAddKey(scriptsDir, pubkey) {
  const key = pubkey.trim();
  if (!key) throw new Error('公钥为空');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const keyFile = path.join(scriptsDir, 'pubkey.tmp');
  fs.writeFileSync(keyFile, key + '\n', 'utf-8');
  const p = writeScript(scriptsDir, 'ssh-addkey.ps1', ADDKEY_SCRIPT);
  execElevated(p, keyFile);
  // 验证公钥真的写入了应用托管授权文件（不依赖提权输出）
  try {
    if (!fs.readFileSync(SSH_AUTH_KEYS, 'utf-8').includes(key)) {
      throw new Error('授权失败：公钥未写入授权文件（请确认 UAC 提示已点击确认）');
    }
  } catch (e) {
    if (e.message && e.message.includes('授权失败')) throw e;
    throw new Error('授权失败：无法读取授权文件（' + (e.message || e) + '）');
  }
  return true;
}

/** 同步共享清单到 C:\ProgramData\inner-net\shares.json（普通权限可能失败，忽略） */
function syncManifest(shares) {
  try {
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    const list = shares.map((s) => ({
      shareName: s.shareName,
      account: s.account,
      password: s.password || '',
    }));
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(list, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ---------- macOS 端 ----------

function getOrCreateKey() {
  const home = os.homedir();
  const sshDir = path.join(home, '.ssh');
  const pubFile = path.join(sshDir, 'id_ed25519.pub');
  if (!fs.existsSync(pubFile)) {
    fs.mkdirSync(sshDir, { recursive: true });
    try {
      runCmd('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', path.join(sshDir, 'id_ed25519'), '-C', `${os.hostname()}@inner-net`]);
    } catch (e) {
      throw new Error('生成密钥失败: ' + e.message);
    }
  }
  const pub = fs.readFileSync(pubFile, 'utf-8').trim();
  return { pub, path: pubFile };
}

/** 通过 SSH 拉取 Windows 共享清单（免密，密钥需已授权） */
function sshPull(host, user, port) {
  if (!host || !user) throw new Error('请输入主机 IP 和用户名');
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
  ];
  if (port && Number(port) !== 22) args.push('-p', String(port));
  args.push(`${user}@${host}`, `type ${MANIFEST_FILE}`);
  const r = spawnSync('ssh', args, { encoding: 'buffer', timeout: 20000 });
  if (r.error) throw new Error('SSH 连接失败: ' + r.error.message);
  if (r.status !== 0) {
    // stderr 可能是 Windows 端 GBK 中文报错（如「系统找不到指定的文件」），先按 GBK 解码，
    // 失败再退回 UTF-8，保证中文可读、友好提示能命中
    const raw = r.stderr || Buffer.alloc(0);
    let err = '';
    try {
      err = new TextDecoder('gbk', { fatal: true }).decode(raw);
    } catch {
      try {
        err = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        err = raw.toString('utf-8');
      }
    }
    if (/Permission denied|denied/i.test(err)) {
      throw new Error('认证失败：请先在 Windows 端「SSH 免密通道」授权这台机器的公钥');
    }
    if (/refused|timed out|timeout|unreachable/i.test(err)) {
      throw new Error(`连接失败：请确认 Windows 端 SSH 服务运行中（端口 ${port || '2222'}）且 IP 正确`);
    }
    if (/not found|cannot find|找不到|系统找不到/i.test(err)) {
      throw new Error('远程命令失败：Windows 端未找到共享清单（C:\\ProgramData\\inner-net\\shares.json）');
    }
    if (/拒绝访问|access is denied/i.test(err)) {
      throw new Error('远程命令失败：Windows 端无权限读取共享清单（请放宽 shares.json 的读取 ACL）');
    }
    // 其他：去掉无法解码的乱码字符，避免 ❓ 刷屏
    const cleaned = err.replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    throw new Error('SSH 拉取失败: ' + (cleaned || '未知错误（exit ' + r.status + '）'));
  }
  const out = (r.stdout || Buffer.alloc(0)).toString('utf-8').trim();
  if (!out) throw new Error('清单为空：请确认 Windows 端已创建共享并同步清单');
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('清单解析失败（返回内容不是有效 JSON）');
  }
}

module.exports = {
  getSshStatus,
  sshEnable,
  sshControl,
  sshSetPort,
  sshAddKey,
  sshListKeys,
  sshRemoveKey,
  ensureAuthFile,
  syncManifest,
  getOrCreateKey,
  sshPull,
  MANIFEST_FILE,
  SSH_PORT,
  SSH_AUTH_KEYS,
};
