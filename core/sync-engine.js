/* global module, require */
const fs = require('fs');
const path = require('path');

const TRASH_DIR = '.innernet-trash';
const INCOMING_DIR = '.innernet-incoming';
const DEFAULT_TRASH_RETENTION_DAYS = 7;
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

/** 相对路径统一成 POSIX 分隔符 —— 跨 Windows/macOS 的同步主键 */
function normalizeRelPath(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '');
}

/** 回收区与暂存目录不参与同步，否则会自己同步自己 */
function isInternalPath(rel) {
  const p = normalizeRelPath(rel);
  return p === TRASH_DIR || p.startsWith(`${TRASH_DIR}/`) || p === INCOMING_DIR || p.startsWith(`${INCOMING_DIR}/`);
}

/**
 * 递归扫描目录，返回 Map<relPath, { size, mtimeMs }>。
 * 用 size+mtime 做变更判定（rsync 同款），避免为每个文件算 sha256。
 */
function scanTree(root, { ignore = isInternalPath } = {}) {
  const out = new Map();
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // 目录不存在或无权限：当作空
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (ignore(rel, entry.isDirectory())) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue; // 符号链接、socket 等跳过
      try {
        const stat = fs.statSync(abs);
        out.set(rel, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      } catch {
        /* 打不开的文件跳过，不让它拖垮整轮同步 */
      }
    }
  };
  walk(root, '');
  return out;
}

/** 与上次索引比对，得出本轮要推送和要移入回收区的相对路径 */
function computePlan(current, index = {}) {
  const toPush = [];
  const toTrash = [];
  for (const [rel, meta] of current) {
    const prev = index[rel];
    if (!prev || prev.size !== meta.size || prev.mtimeMs !== meta.mtimeMs) toPush.push(rel);
  }
  for (const rel of Object.keys(index)) {
    if (!current.has(rel)) toTrash.push(rel);
  }
  return { toPush: toPush.sort(), toTrash: toTrash.sort() };
}

/**
 * 主从单向：从端有而主端没有的文件视为多余，需要清理。
 * 只在全量校验轮调用 —— 日常增量不该拿从端清单去比对。
 */
function extrasOnSlave(current, slaveList = []) {
  const extras = [];
  for (const rel of slaveList) {
    const norm = normalizeRelPath(rel);
    if (norm && !current.has(norm)) extras.push(norm);
  }
  return [...new Set(extras)].sort();
}

function toIndex(current) {
  return Object.fromEntries([...current].map(([rel, meta]) => [rel, { size: meta.size, mtimeMs: meta.mtimeMs }]));
}

/** 回收区时间戳目录名：YYYYMMDD-HHmmss */
function trashStamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 回收后保留原相对路径结构，便于按目录整体恢复 */
function trashDestination(rel, now = Date.now()) {
  return `${TRASH_DIR}/${trashStamp(now)}/${normalizeRelPath(rel)}`;
}

function parseTrashStamp(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(name || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 超过保留期的回收批次（按时间戳目录整批清理） */
function purgeStamps(trashEntries = [], retentionDays = DEFAULT_TRASH_RETENTION_DAYS, now = Date.now()) {
  const days = Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : DEFAULT_TRASH_RETENTION_DAYS;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const name of trashEntries) {
    const ts = parseTrashStamp(name);
    if (ts !== null && ts < cutoff) out.push(name);
  }
  return out.sort();
}

function chunkPlan(size, chunkSize = DEFAULT_CHUNK_SIZE) {
  const total = Number.isSafeInteger(size) && size >= 0 ? size : 0;
  const each = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;
  const chunkCount = total === 0 ? 0 : Math.ceil(total / each);
  return { size: total, chunkSize: each, chunkCount };
}

/** 失败重试退避：1s → 2s → 4s … 上限 30s */
function backoffMs(attempt, base = 1000, max = 30000) {
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  return Math.min(max, base * 2 ** (n - 1));
}

module.exports = {
  TRASH_DIR,
  INCOMING_DIR,
  DEFAULT_TRASH_RETENTION_DAYS,
  DEFAULT_CHUNK_SIZE,
  backoffMs,
  chunkPlan,
  computePlan,
  extrasOnSlave,
  isInternalPath,
  normalizeRelPath,
  parseTrashStamp,
  purgeStamps,
  scanTree,
  toIndex,
  trashDestination,
  trashStamp,
};
