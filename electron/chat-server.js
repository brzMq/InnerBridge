/**
 * 局域网聊天服务（内嵌于 Windows 共享端主进程）
 * - GET  /           网页版聊天室（手机/任意浏览器可用）
 * - GET  /api/msg    消息历史
 * - POST /api/msg    发送消息 {nick, text}
 * - GET  /api/stream SSE 实时推送
 * 零依赖：Node 原生 http。消息持久化到 messages.jsonl，内存与文件均上限 MAX_MSG（1000）条。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeClientId,
  resolveReply,
  selectMessages,
} = require('./chat-protocol');

const MAX_MSG = 1000; // 内存与持久化文件的最大消息条数（超出裁剪最旧的）
const MAX_NICK = 32;
const MAX_TEXT = 2000;
const MAX_IMG = 5 * 1024 * 1024; // 图片大小上限 5MB
const MAX_TEXT_FILE = 1 * 1024 * 1024;
const MAX_ARCHIVE = 200 * 1024 * 1024;
// 允许上传的文本文件扩展名（白名单）
const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'adoc', 'csv', 'tsv', 'log', 'json', 'json5', 'jsonl',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env', 'xml', 'xsl', 'xsd', 'sql',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro', 'py', 'rb', 'php', 'java',
  'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh',
  'fish', 'bat', 'cmd', 'ps1', 'psm1', 'html', 'htm', 'css', 'scss', 'less', 'graphql', 'gql',
  'tex', 'rtf', 'svg',
]);
const ARCHIVE_EXTS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'heic', 'heif']);

// ---------- 持久化 ----------

function loadPersist(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const msgs = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((m) => m && typeof m.id === 'number' && typeof m.text === 'string');
    return msgs.slice(-MAX_MSG);
  } catch {
    return [];
  }
}

function appendPersist(file, msg) {
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(msg) + '\n', 'utf-8');
  } catch {
    /* 磁盘失败不影响聊天 */
  }
}

function rewritePersist(file, list) {
  if (!file) return;
  try { fs.writeFileSync(file, list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''), 'utf-8'); } catch { /* ignore */ }
}

/** 纯函数：把消息行裁剪到最近 max 条（保留末尾），供单测；未超限时返回原数组 */
function trimLines(lines, max) {
  if (!Array.isArray(lines) || lines.length <= max) return lines;
  return lines.slice(-max);
}

/** 文件行数超过上限时裁剪（保留最近 MAX_MSG 条），用临时文件+rename 原子重写降低损坏风险 */
function trimPersist(file) {
  if (!file || !fs.existsSync(file)) return;
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const keptArr = trimLines(lines, MAX_MSG);
    if (keptArr.length === lines.length) return; // 未超上限，无需重写
    const kept = keptArr.join('\n') + '\n';
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, kept, 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* 忽略 */
  }
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 读取二进制请求体（图片上传用），限制最大字节数 */
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('文件超过大小限制'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 通过 magic bytes 检测图片类型，返回 {ext, mime} 或 null */
function detectImageType(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return { ext: 'tiff', mime: 'image/tiff' };
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return { ext: 'ico', mime: 'image/x-icon' };
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx'].includes(brand)) {
      return { ext: brand.startsWith('hei') ? 'heic' : 'avif', mime: brand.startsWith('hei') ? 'image/heic' : 'image/avif' };
    }
  }
  return null;
}

/** 保存图片到图片目录，返回相对 URL（如 /img/xxx.png） */
function saveImage(imagesDir, buf) {
  if (!imagesDir) throw new Error('图片存储未配置');
  const type = detectImageType(buf);
  if (!type) throw new Error('不支持的图片类型（支持 png/jpg/gif/webp/bmp/tiff/ico/avif/heic）');
  fs.mkdirSync(imagesDir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${type.ext}`;
  fs.writeFileSync(path.join(imagesDir, name), buf);
  return `/img/${name}`;
}

/** 校验并保存文本文件到文件目录，返回 {url, name, size}（如 /file/xxx.txt） */
function saveTextFile(filesDir, buf, origName) {
  if (!filesDir) throw new Error('文件存储未配置');
  const clean = String(origName || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'file.txt';
  const ext = (path.extname(clean).slice(1) || '').toLowerCase();
  if (!TEXT_EXTS.has(ext)) throw new Error('不支持的文件类型（仅支持文本文件: txt/md/json/csv 等）');
  // 内容必须为合法 UTF-8 文本
  if (buf.includes(0)) throw new Error('文件包含二进制内容，不是纯文本');
  fs.mkdirSync(filesDir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(filesDir, name), buf);
  return { url: `/file/${name}`, name: clean, size: buf.length };
}

function cleanUploadName(origName, fallback) {
  return String(origName || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120) || fallback;
}

function uploadPolicy(origName, contentType) {
  const ext = path.extname(String(origName || '')).slice(1).toLowerCase();
  if (String(contentType || '').toLowerCase().startsWith('image/') || IMAGE_EXTS.has(ext)) {
    return { kind: 'image', maxBytes: MAX_IMG };
  }
  if (ARCHIVE_EXTS.has(ext)) return { kind: 'archive', maxBytes: MAX_ARCHIVE };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', maxBytes: MAX_TEXT_FILE };
  throw new Error('不支持的文件类型（支持图片、文本及 zip/7z/rar/tar/gz 等压缩文件）');
}

function saveArchiveFile(filesDir, buf, origName, folder) {
  if (!filesDir) throw new Error('文件存储未配置');
  const clean = cleanUploadName(origName, 'archive.zip');
  const ext = path.extname(clean).slice(1).toLowerCase();
  if (!ARCHIVE_EXTS.has(ext)) throw new Error('不支持的压缩文件类型');
  fs.mkdirSync(filesDir, { recursive: true });
  const stored = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(filesDir, stored), buf);
  return { url: `/file/${stored}`, name: clean, size: buf.length, kind: folder ? 'folder' : 'archive' };
}

function startChatServer(preferredPort = 7890, opts = {}) {
  const persistFile = opts.file || null;
  const imagesDir = opts.imagesDir || null;
  const filesDir = opts.filesDir || null;
  const listenHost = opts.host || '0.0.0.0';
  const onEvent = (e) => { try { opts.onEvent && opts.onEvent(e); } catch { /* 忽略日志回调自身异常 */ } };
  const messages = loadPersist(persistFile);
  const clients = new Set();
  let maxId = messages.reduce((max, message) => Math.max(max, message.id || 0), 0);

  const broadcastEvent = (event, data) => {
    const payload = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  };
  const broadcast = (msg) => broadcastEvent('', msg);
  const broadcastPresence = () => broadcastEvent('presence', { online: clients.size });

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // 网页版聊天室
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/vendor/jszip.min.js') {
      const jszip = require.resolve('jszip/dist/jszip.min.js');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(jszip).pipe(res);
      return;
    }

    // 消息历史
    if (req.method === 'GET' && url.pathname === '/api/msg') {
      const list = selectMessages(messages, {
        since: url.searchParams.get('since'),
        limit: url.searchParams.get('limit'),
        q: url.searchParams.get('q'),
      });
      sendJSON(res, 200, { messages: list });
      return;
    }


    // 文件上传（二进制 body；文件夹由客户端压缩为 zip，并附带 ?folder=1）
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      try {
        const origName = url.searchParams.get('name') || '';
        const policy = uploadPolicy(origName, req.headers['content-type']);
        const buf = await readBodyBuffer(req, policy.maxBytes);
        if (!buf.length) return sendJSON(res, 400, { error: '未收到文件内容' });
        const imgUrl = detectImageType(buf) ? saveImage(imagesDir, buf) : null;
        if (imgUrl) {
          onEvent({ level: 'info', source: 'chat', message: `图片已上传: ${imgUrl} (${buf.length} 字节)` });
          return sendJSON(res, 200, { ok: true, url: imgUrl, kind: 'image' });
        }
        if (policy.kind === 'image') throw new Error('图片内容与文件类型不匹配');
        if (policy.kind === 'archive') {
          const f = saveArchiveFile(filesDir, buf, origName, url.searchParams.get('folder') === '1');
          onEvent({ level: 'info', source: 'chat', message: `${f.kind === 'folder' ? '文件夹' : '压缩文件'}已上传: ${f.name} (${f.size} 字节)` });
          return sendJSON(res, 200, { ok: true, ...f });
        }
        const f = saveTextFile(filesDir, buf, origName);
        onEvent({ level: 'info', source: 'chat', message: `文本文件已上传: ${f.name} (${f.size} 字节)` });
        return sendJSON(res, 200, { ok: true, url: f.url, name: f.name, size: f.size, kind: 'text' });
      } catch (e) {
        onEvent({ level: 'warn', source: 'chat', message: '文件上传失败: ' + (e.message || e) });
        return sendJSON(res, 400, { error: String(e.message || e) });
      }
    }

    // 图片访问（静态服务，basename 防路径穿越）
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      const name = path.basename(url.pathname);
      const file = imagesDir ? path.join(imagesDir, name) : null;
      if (!file || !fs.existsSync(file)) return sendJSON(res, 404, { error: '图片不存在' });
      const head = fs.readFileSync(file).slice(0, 12);
      const type = detectImageType(head);
      res.writeHead(200, {
        'Content-Type': type ? type.mime : 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3600',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // 文本文件下载（附件，basename 防路径穿越）
    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      const name = path.basename(url.pathname);
      const file = filesDir ? path.join(filesDir, name) : null;
      if (!file || !fs.existsSync(file)) return sendJSON(res, 404, { error: '文件不存在' });
      const ext = path.extname(name).slice(1).toLowerCase();
      const mime = {
        txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', log: 'text/plain',
        zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
        tar: 'application/x-tar', gz: 'application/gzip', tgz: 'application/gzip',
        bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': TEXT_EXTS.has(ext) ? mime + '; charset=utf-8' : mime,
        'Content-Disposition': `attachment; filename="file-${name}"`,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // 发送消息（支持图片 image、文本文件 file，text 可为空）
    if (req.method === 'POST' && url.pathname === '/api/msg') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const nick = String(body.nick || '').trim().slice(0, MAX_NICK);
        const text = String(body.text || '').trim().slice(0, MAX_TEXT);
        const clientId = normalizeClientId(body.clientId);
        const image = typeof body.image === 'string' && /^\/img\/[A-Za-z0-9._-]+$/.test(body.image) ? body.image : null;
        const file =
          body.file && typeof body.file === 'object' &&
          typeof body.file.url === 'string' && /^\/file\/[A-Za-z0-9._-]+$/.test(body.file.url) &&
          typeof body.file.name === 'string' && body.file.name.length <= 80
            ? {
                url: body.file.url,
                name: body.file.name.slice(0, 80),
                kind: ['text', 'archive', 'folder'].includes(body.file.kind) ? body.file.kind : 'text',
                size: Number.isFinite(body.file.size) && body.file.size >= 0 ? Math.floor(body.file.size) : 0,
              }
            : null;
        if (!nick) {
          onEvent({ level: 'warn', source: 'chat', message: '消息被拒: 昵称为空' });
          return sendJSON(res, 400, { error: '昵称不能为空' });
        }
        if (!text && !image && !file) {
          onEvent({ level: 'warn', source: 'chat', message: '消息被拒: 内容为空' });
          return sendJSON(res, 400, { error: '内容不能为空' });
        }
        if (clientId) {
          const existing = messages.find((message) => message.clientId === clientId);
          if (existing) return sendJSON(res, 200, { ok: true, duplicate: true, msg: existing });
        }
        const reply = resolveReply(body.replyTo, messages);
        const msg = {
          id: ++maxId,
          nick,
          text,
          ts: Date.now(),
          ...(clientId ? { clientId } : {}),
          ...(reply ? { reply } : {}),
          ...(image ? { image } : {}),
          ...(file ? { file } : {}),
        };
        messages.push(msg);
        appendPersist(persistFile, msg);
        if (messages.length > MAX_MSG) {
          messages.splice(0, messages.length - MAX_MSG);
          trimPersist(persistFile); // 先追加后裁剪，文件最多 MAX_MSG+1 行 → 裁到 MAX_MSG
        }
        broadcast(msg);
        let preview;
        if (image) preview = '[图片]' + (text.length > 100 ? text.slice(0, 100) + '…' : text);
        else if (file) preview = `[文件] ${file.name}`;
        else preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
        onEvent({ level: 'info', source: 'chat', message: `消息 [${msg.nick}]: ${preview}` });
        sendJSON(res, 200, { ok: true, msg });
      } catch (e) {
        onEvent({ level: 'warn', source: 'chat', message: '消息被拒: ' + (e.message || e) });
        sendJSON(res, 400, { error: String(e.message || e) });
      }
      return;
    }


    // SSE 实时推送
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      clients.add(res);
      broadcastPresence();
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* close handler cleans up */ }
      }, 20000);
      onEvent({ level: 'info', source: 'chat', message: `SSE 客户端接入，当前在线 ${clients.size}` });
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        broadcastPresence();
        onEvent({ level: 'info', source: 'chat', message: `SSE 客户端断开，剩余 ${clients.size}` });
      });
      return;
    }

    sendJSON(res, 404, { error: 'not found' });
  };

  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < preferredPort + 10) {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, listenHost, () => {
        const actualPort = server.address().port;
        resolve({ port: actualPort, url: `http://127.0.0.1:${actualPort}` });
      });
    };
    tryPort(preferredPort);
  }).then((info) => ({
    ...info,
    server,
    messages,
    broadcast,
    broadcastEvent,
    online: () => clients.size,
    deleteMessages: (ids) => { const wanted = new Set((ids || []).map(Number)); const kept = messages.filter((m) => !wanted.has(m.id)); messages.splice(0, messages.length, ...kept); rewritePersist(persistFile, messages); broadcastEvent('reset', { reason: 'delete' }); return kept.length; },
  }));
}

module.exports = { startChatServer, trimLines, uploadPolicy };
