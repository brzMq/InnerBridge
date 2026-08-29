const path = require('path');

/** RFC 3986 URL component encoding (encodeURIComponent leaves a few reserved characters). */
function encodeSmbComponent(value) {
  return encodeURIComponent(String(value ?? '')).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function validateMount(mount) {
  const m = mount || {};
  if (!String(m.host || '').trim()) throw new Error('缺少 Windows 主机地址');
  if (!/^[A-Za-z0-9.-]+$/.test(String(m.host).trim())) {
    throw new Error(`Windows 主机地址格式无效: ${m.host}`);
  }
  if (!String(m.account || '').trim()) throw new Error('缺少 SMB 账号');
  if (!String(m.shareName || '').trim()) throw new Error('缺少共享名');
  if (typeof m.password !== 'string' || !m.password.length) {
    throw new Error(`共享「${m.shareName || '未命名'}」缺少密码，请重新同步清单或手动填写`);
  }
  if (!String(m.mountPoint || '').trim() || !path.isAbsolute(m.mountPoint)) {
    throw new Error(`挂载目录必须是绝对路径: ${m.mountPoint || '(空)'}`);
  }
  if (/[\n\r\0]/.test(`${m.account}${m.shareName}${m.mountPoint}`)) {
    throw new Error('挂载信息包含非法换行或空字符');
  }
  return {
    ...m,
    host: String(m.host).trim(),
    account: String(m.account).trim(),
    shareName: String(m.shareName).trim(),
    mountPoint: String(m.mountPoint).trim(),
  };
}

/** Build a URL accepted by mount_smbfs/autofs without any interactive password prompt. */
function buildSmbUrl(mount) {
  const m = validateMount(mount);
  return `//${encodeSmbComponent(m.account)}:${encodeSmbComponent(m.password)}@${m.host}/${encodeSmbComponent(m.shareName)}`;
}

/** Escape a direct-map key. Spaces must not split an autofs map entry. */
function escapeAutofsKey(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([\s#])/g, '\\$1');
}

function buildAutofsMap(mounts) {
  if (!Array.isArray(mounts) || !mounts.length) throw new Error('挂载列表为空');
  return mounts
    .map((mount) => {
      const m = validateMount(mount);
      return `${escapeAutofsKey(m.mountPoint)} -fstype=smbfs,nosuid,noowners ${buildSmbUrl(m)}`;
    })
    .join('\n') + '\n';
}

/** Never let a command error echo an SMB password back into the UI/log. */
function redactMountError(error, mount) {
  let message = String(error && error.message ? error.message : error);
  const secrets = [mount && mount.password, mount && encodeSmbComponent(mount.password || '')]
    .filter(Boolean);
  for (const secret of secrets) message = message.split(secret).join('***');
  return message;
}

/** Check macOS `mount` output by destination path, not by share/account text. */
function isMountPointMounted(mountOutput, mountPoint) {
  const target = String(mountPoint || '').trim();
  if (!target) return false;
  const marker = ` on ${target} (`;
  return String(mountOutput || '')
    .split(/\r?\n/)
    .some((line) => line.includes(marker));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Build a user LaunchAgent worker: idempotent mount checks, no interactive prompts. */
function buildAutoMountScript(mounts) {
  if (!Array.isArray(mounts) || !mounts.length) throw new Error('挂载列表为空');
  const lines = ['#!/bin/sh', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'failed=0', ''];
  for (const mount of mounts) {
    const m = validateMount(mount);
    const marker = ` on ${m.mountPoint} (`;
    lines.push(
      `if /usr/bin/nc -z -w 3 ${shellQuote(m.host)} 445 >/dev/null 2>&1; then`,
      `  if ! /sbin/mount | /usr/bin/grep -Fq ${shellQuote(marker)}; then`,
      `    if ! /bin/mkdir -p ${shellQuote(m.mountPoint)} || ! /sbin/mount -t smbfs ${shellQuote(buildSmbUrl(m))} ${shellQuote(m.mountPoint)}; then`,
      '      failed=1',
      '    fi',
      '  fi',
      'fi',
      ''
    );
  }
  lines.push('exit "$failed"', '');
  return lines.join('\n');
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildLaunchAgentPlist({ label, scriptPath, stdoutPath, stderrPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${xmlEscape(scriptPath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

module.exports = {
  buildAutoMountScript,
  buildAutofsMap,
  buildLaunchAgentPlist,
  buildSmbUrl,
  encodeSmbComponent,
  escapeAutofsKey,
  isMountPointMounted,
  redactMountError,
  shellQuote,
  validateMount,
};
