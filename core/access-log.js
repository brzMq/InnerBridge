/**
 * 访问记录：记录「访问过本机的设备」。
 *
 * 来源：群聊（发言）、共享清单（拉取共享）、文件同步（同步请求）等入口，
 * 在各服务处理请求成功时记录 { requesterId, ip, kind, name, at }。
 * 同一 requesterId + kind 只保留最近一次；总量上限防膨胀。
 * 存储为 JSON 数组（access-log.json），非机密、仅本机展示用。
 */
/* global module, require */
const fs = require('fs');
const path = require('path');

function createAccessLog(file, limit = 50) {
  let entries = load();

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
      fs.renameSync(tmp, file);
    } catch {
      /* 记录失败不影响业务 */
    }
  }

  return {
    record({ requesterId, ip = '', kind = '', name = '' } = {}) {
      const id = String(requesterId || '');
      if (!id) return null;
      // 同一设备同一来源只保留最近一次，避免刷屏
      entries = entries.filter((e) => !(e.requesterId === id && e.kind === kind));
      const entry = { requesterId: id, ip: String(ip || ''), kind: String(kind || ''), name: String(name || ''), at: new Date().toISOString() };
      entries.unshift(entry);
      if (entries.length > limit) entries = entries.slice(0, limit);
      save();
      return entry;
    },
    list: () => entries.map((e) => ({ ...e })),
    clear: () => { entries = []; save(); return { ok: true }; },
  };
}

module.exports = { createAccessLog };
