/** Normalize a Windows account for SMB share-level ACL APIs. */
function normalizeWindowsPrincipal(account, hostname) {
  const raw = String(account || '').trim();
  if (!raw) throw new Error('授权账号为空');

  if (raw.includes('\\')) {
    const slash = raw.indexOf('\\');
    const authority = raw.slice(0, slash).trim();
    const username = raw.slice(slash + 1).trim();
    if (!authority || !username || username.includes('\\')) {
      throw new Error(`授权账号格式无效: ${raw}（必须为 机器名\\用户名 或 域\\用户名）`);
    }
    return `${authority}\\${username}`;
  }

  const machine = String(hostname || '').trim();
  if (!machine) throw new Error('无法确定 Windows 机器名');
  return `${machine}\\${raw}`;
}

function normalizeAccessEntries(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hasFullAllowAccess(entries, principal) {
  const expected = String(principal || '').toLowerCase();
  return normalizeAccessEntries(entries).some((entry) =>
    String(entry && entry.accountName || '').toLowerCase() === expected &&
    entry.isFull === true &&
    entry.isAllow === true
  );
}

function parseAccessJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  return normalizeAccessEntries(JSON.parse(raw));
}

module.exports = {
  hasFullAllowAccess,
  normalizeAccessEntries,
  normalizeWindowsPrincipal,
  parseAccessJson,
};
