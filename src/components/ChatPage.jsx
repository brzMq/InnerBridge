import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

const NICK_KEY = 'inner-net-nick';
const HOST_KEY = 'inner-net-chat-host';

const createClientId = () =>
  globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;

function mergeMessage(list, message) {
  if (!message || !message.id || list.some((item) => item.id === message.id)) return list;
  return [...list, message].sort((a, b) => a.id - b.id).slice(-200);
}

export default function ChatPage({ isWin }) {
  const [serverUrl, setServerUrl] = useState('');
  const [nick, setNick] = useState(() => localStorage.getItem(NICK_KEY) || '');
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('connecting');
  const [lanUrl, setLanUrl] = useState('');
  const [online, setOnline] = useState(0);
  const [query, setQuery] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [sending, setSending] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [storage, setStorage] = useState(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [unread, setUnread] = useState(0);
  const [notifyEnabled, setNotifyEnabled] = useState(() => localStorage.getItem('inner-net-chat-notify') !== 'off');
  const listRef = useRef(null);
  const esRef = useRef(null);

  // Windows 端：自动获取本机聊天服务；Mac 端：记住上次填的服务器
  useEffect(() => {
    if (isWin) {
      window.api.chat.info().then((i) => {
        setServerUrl(i.url);
        setLanUrl(i.lanUrl);
        setOnline(i.online);
      });
    } else {
      const saved = localStorage.getItem(HOST_KEY);
      if (saved) setServerUrl(saved);
    }
  }, [isWin]);

  // 连接聊天服务
  useEffect(() => {
    if (!serverUrl) return;
    if (esRef.current) esRef.current.close();
    setStatus('connecting');
    setMessages([]);

    const es = new EventSource(`${serverUrl}/api/stream`);
    esRef.current = es;
    es.onopen = () => setStatus('connected');
    es.onerror = () => setStatus('disconnected');
    es.addEventListener('presence', (e) => {
      try { setOnline(Number(JSON.parse(e.data).online) || 0); } catch { /* 忽略坏事件 */ }
    });
    es.addEventListener('reset', () => {
      setMessages([]);
      setReplyTo(null);
    });
    es.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        setMessages((prev) => mergeMessage(prev, m));
        if (m.nick !== nick && document.visibilityState !== 'visible') {
          setUnread((n) => n + 1);
          if (notifyEnabled && 'Notification' in globalThis && globalThis.Notification.permission === 'granted') new globalThis.Notification(`${m.nick} 发来新消息`, { body: m.text || (m.file ? `[文件] ${m.file.name}` : '[图片]') });
        }
      } catch { /* 忽略坏消息 */ }
    };

    fetch(`${serverUrl}/api/msg?limit=200`)
      .then((r) => r.json())
      .then((d) => setMessages((prev) => (d.messages || []).reduce(mergeMessage, prev)))
      .catch(() => {});
    return () => es.close();
  }, [serverUrl, nick, notifyEnabled]);

  useEffect(() => { const reset = () => setUnread(0); document.addEventListener('visibilitychange', reset); return () => document.removeEventListener('visibilitychange', reset); }, []);
  useEffect(() => {
    const closeMenu = (event) => {
      if (!event.target.closest('.chat-attach-wrap')) setAttachMenuOpen(false);
    };
    document.addEventListener('mousedown', closeMenu);
    return () => document.removeEventListener('mousedown', closeMenu);
  }, []);

  useEffect(() => {
    if (!previewImage) return undefined;
    const close = (event) => { if (event.key === 'Escape') setPreviewImage(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [previewImage]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  // 本机设备身份（实名进入群聊，匿名会被服务端拒绝）
  const [myId, setMyId] = useState('');
  const [myName, setMyName] = useState('');
  useEffect(() => {
    window.api.device?.info?.().then((info) => {
      if (info?.deviceId) setMyId(info.deviceId);
      setMyName(info?.deviceName || '');
    }).catch(() => {});
  }, []);

  // 简易 toast
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || !serverUrl || sending) return;
    setSending(true);
    try {
      const response = await fetch(`${serverUrl}/api/msg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: createClientId(),
          requesterId: myId,
          nick: nick || myName || '我的设备',
          text: t,
          ...(replyTo ? { replyTo: { id: replyTo.id } } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '发送失败');
      setMessages((prev) => mergeMessage(prev, data.msg));
      setText('');
      setReplyTo(null);
    } catch (e) {
      showToast(String(e.message || e), false);
    } finally {
      setSending(false);
    }
  }, [text, nick, serverUrl, sending, replyTo, showToast]);


  // 图片、文本、压缩文件上传与发送
  const fileRef = useRef(null);
  const folderRef = useRef(null);
  const sendFile = useCallback(
    async (file, options = {}) => {
      if (!serverUrl || status !== 'connected') return showToast('未连接', false);
      const isImg = /^image\//.test(file.type);
      const archive = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i.test(file.name || '');
      if (isImg && file.size > 5 * 1024 * 1024) return showToast('图片不能超过 5MB', false);
      if (!isImg && !archive && file.size > 1 * 1024 * 1024) return showToast('文本文件不能超过 1MB', false);
      if (archive && file.size > 200 * 1024 * 1024) return showToast('压缩文件不能超过 200MB', false);
      try {
        const suffix = options.folder ? '&folder=1' : '';
        const up = await fetch(`${serverUrl}/api/upload?name=${encodeURIComponent(file.name || '')}&requesterId=${encodeURIComponent(myId)}${suffix}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        const ud = await up.json();
        if (!ud.ok || !ud.url) throw new Error(ud.error || '上传失败');
        const payload = {
          clientId: createClientId(),
          requesterId: myId,
          nick: nick || myName || '我的设备',
          text: text.trim(),
          ...(replyTo ? { replyTo: { id: replyTo.id } } : {}),
        };
        if (ud.kind !== 'image') payload.file = { url: ud.url, name: ud.name, kind: ud.kind, size: ud.size };
        else payload.image = ud.url;
        const m = await fetch(`${serverUrl}/api/msg`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const md = await m.json();
        if (!md.ok) throw new Error(md.error || '发送失败');
        setMessages((prev) => mergeMessage(prev, md.msg));
        setText('');
        setReplyTo(null);
        showToast(ud.kind === 'image' ? '图片已发送' : ud.kind === 'folder' ? '文件夹已发送' : '文件已发送');
      } catch (e) {
        showToast(String(e.message || e), false);
      }
    },
    [serverUrl, status, nick, text, replyTo, showToast]
  );

  const sendFolder = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (files.length > 500) return showToast('文件夹最多包含 500 个文件', false);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > 200 * 1024 * 1024) return showToast('文件夹原始内容不能超过 200MB', false);
    setSending(true);
    try {
      showToast(`正在压缩 ${files.length} 个文件…`);
      const zip = new JSZip();
      files.forEach((file) => zip.file(file.relativePath || file.webkitRelativePath || file.name, file));
      const root = (files[0].relativePath || files[0].webkitRelativePath || '文件夹').split('/')[0] || '文件夹';
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      if (blob.size > 200 * 1024 * 1024) throw new Error('压缩后文件超过 200MB');
      await sendFile(new globalThis.File([blob], `${root}.zip`, { type: 'application/zip' }), { folder: true });
    } catch (e) {
      showToast(String(e.message || e), false);
    } finally {
      setSending(false);
    }
  }, [sendFile, showToast]);

  const sendFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    for (const file of files) await sendFile(file);
  }, [sendFile]);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragging(false);
    const entries = Array.from(e.dataTransfer?.items || [])
      .map((item) => item.webkitGetAsEntry?.())
      .filter(Boolean);
    try {
      if (entries.some((entry) => entry.isDirectory)) {
        const files = [];
        for (const entry of entries) await collectEntryFiles(entry, files);
        await sendFolder(files);
      } else {
        await sendFiles(e.dataTransfer?.files || []);
      }
    } catch (error) {
      showToast(String(error.message || error), false);
    }
  }, [sendFiles, sendFolder, showToast]);

  const loadStorage = useCallback(async () => {
    if (!isWin) return;
    setStorageBusy(true);
    try { setStorage(await window.api.chat.storageStats()); }
    catch (e) { showToast(String(e.message || e), false); }
    finally { setStorageBusy(false); }
  }, [isWin, showToast]);

  const openStorage = useCallback(() => {
    setStorageOpen(true);
    loadStorage();
  }, [loadStorage]);

  const clearStorage = useCallback(async (scope) => {
    const labels = { messages: '清空全部聊天记录', orphaned: '删除未被消息引用的缓存文件', all: '清空聊天记录及全部文件缓存' };
    if (!window.confirm(`确定要${labels[scope]}吗？此操作无法撤销。`)) return;
    setStorageBusy(true);
    try {
      const result = await window.api.chat.clearStorage(scope);
      setStorage(result.stats);
      showToast(`清理完成，释放 ${formatBytes(result.removedBytes)}`);
    } catch (e) { showToast(String(e.message || e), false); }
    finally { setStorageBusy(false); }
  }, [showToast]);

  // 聊天区粘贴：剪贴板有图片 → 直接上传发送；文字 → 填入输入框
  const onPaste = useCallback(
    (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            sendFile(f);
            return;
          }
        }
      }
      // 纯文字：允许默认（textarea 本身支持），若焦点不在输入框则补进输入框
      if (document.activeElement !== e.target && e.target.tagName !== 'TEXTAREA') {
        const t = e.clipboardData.getData('text/plain');
        if (t) {
          e.preventDefault();
          setText((prev) => prev + t);
        }
      }
    },
    [sendFile]
  );

  // 图片点击复制（fetch blob → clipboard）
  const copyImage = useCallback(async (url) => {
    try {
      const r = await fetch(url);
      const blob = await r.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      showToast('图片已复制');
    } catch {
      showToast('复制图片失败（此环境不支持）', false);
    }
  }, [showToast]);

  // 文字消息保存为 .txt 下载
  const saveText = useCallback((txt) => {
    const blob = new Blob([txt || ''], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `消息-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 100);
    showToast('已保存为 txt');
  }, [showToast]);

  const copyMsg = useCallback(async (m) => {
    try {
      await navigator.clipboard.writeText(m.text);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // 降级：创建隐藏输入框复制
      const ta = document.createElement('textarea');
      ta.value = m.text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  }, []);

  const connect = () => {
    const raw = serverUrl.trim().replace(/\/+$/, '');
    const url = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
    setServerUrl(url);
    localStorage.setItem(HOST_KEY, url);
  };

  const visibleMessages = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return messages;
    return messages.filter((m) =>
      [m.nick, m.text, m.file?.name, m.reply?.text]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase()
        .includes(keyword)
    );
  }, [messages, query]);

  return (
    <div
      className={`chat-page ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {dragging && <div className="chat-drop-overlay">松开鼠标发送文件或文件夹</div>}
      <div className="chat-head">
        <div className="chat-title">
          <div className="chat-title-copy">
            <h3>局域网群聊</h3>
            <div className="chat-status">
              <span className={`chat-dot ${status === 'connected' ? 'on' : ''}`} />
              {status === 'connected' ? `连接正常 · ${online} 人在线` : status === 'connecting' ? '正在连接…' : '连接已断开'}
            </div>
          </div>
        </div>
        <div className="chat-setup">
          {isWin && <button className="btn small ghost" onClick={openStorage}>记录管理</button>}
          {!isWin && (
            <div className="row chat-server-row">
              <input
                className="text-input chat-server-input"
                placeholder="服务器地址，如 192.168.5.50:7890"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connect()}
              />
              <button className="btn small" onClick={connect}>连接</button>
            </div>
          )}
          <input
            className="text-input chat-search-input"
            placeholder="搜索消息…"
            aria-label="搜索消息"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className={`btn small chat-notify-btn ${notifyEnabled ? 'is-on' : ''}`} onClick={async () => { const next = !notifyEnabled; setNotifyEnabled(next); localStorage.setItem('inner-net-chat-notify', next ? 'on' : 'off'); if (next && 'Notification' in globalThis && globalThis.Notification.permission === 'default') await globalThis.Notification.requestPermission(); }}>{notifyEnabled ? '通知已开' : '通知已关'}{unread ? ` · ${unread}` : ''}</button>
          <input
            className="text-input chat-nick-input"
            placeholder="昵称"
            maxLength={32}
            value={nick}
            onChange={(e) => {
              setNick(e.target.value);
              localStorage.setItem(NICK_KEY, e.target.value);
            }}
          />
        </div>
      </div>

      {isWin && lanUrl && (
        <div className="lan-banner">
          <span className="lan-banner-icon">⌁</span>
          <div>
            <strong>邀请其他设备加入</strong>
            <span>在手机或其他设备浏览器打开 <code className="mono">{lanUrl}</code></span>
          </div>
          <button className="btn small ghost" onClick={async () => { await navigator.clipboard?.writeText(lanUrl); showToast('群聊地址已复制'); }}>复制地址</button>
        </div>
      )}

      <div className="chat-list" ref={listRef}>
        {visibleMessages.length === 0 ? (
          <div className="chat-empty">
            <span className="chat-empty-icon">{query ? '⌕' : '◇'}</span>
            <strong>{query ? '没有匹配的消息' : status === 'connected' ? '群聊已经准备好了' : '正在等待连接'}</strong>
            <span>{query ? '换个关键词再试试' : status === 'connected' ? '发一条消息，开始和局域网设备交流' : '连接成功后即可收发消息'}</span>
          </div>
        ) : (
          visibleMessages.map((m) => (
            <div className={`chat-msg ${m.nick === nick ? 'mine' : ''}`} key={`${m.id}-${m.ts}`}>
              <span className="chat-avatar" aria-hidden="true">{String(m.nick || '?').trim().slice(0, 1).toLocaleUpperCase()}</span>
              <div className="chat-msg-content">
                <div className="chat-msg-actions">
                  <button className="chat-copy" onClick={() => setReplyTo(m)}>回复</button>
                  {m.image && (
                    <button className="chat-copy" onClick={() => setPreviewImage({ url: `${serverUrl}${m.image}`, nick: m.nick, ts: m.ts })}>预览</button>
                  )}
                  {m.text && (
                    <button className="chat-copy" onClick={() => copyMsg(m)}>
                      {copiedId === m.id ? '已复制 ✓' : '复制'}
                    </button>
                  )}
                  {m.text && (
                    <button className="chat-copy" onClick={() => saveText(m.text)} title="保存为 txt 下载">保存</button>
                  )}
                </div>
                <div className="chat-msg-head">
                  <span className="chat-msg-nick">{m.nick}</span>
                  <span>{new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="chat-msg-bubble">
                  {m.reply && (
                    <div className="chat-reply-quote">
                      <strong>{m.reply.nick}</strong>
                      <span>{m.reply.text}</span>
                    </div>
                  )}
                  {m.image && (
                    <img
                      className="chat-img"
                      src={`${serverUrl}${m.image}`}
                      alt="图片"
                      loading="lazy"
                      title="点击预览图片"
                      onClick={() => setPreviewImage({ url: `${serverUrl}${m.image}`, nick: m.nick, ts: m.ts })}
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  )}
                  {m.file && (
                    <a className="chat-file" href={`${serverUrl}${m.file.url}`} download={m.file.name} title="点击下载">
                      <span className="chat-file-icon">{m.file.kind === 'folder' ? '🗂️' : m.file.kind === 'archive' ? '🗜️' : '📄'}</span>
                      <span className="chat-file-name">{m.file.name}</span>
                      <span className="chat-file-dl">下载</span>
                    </a>
                  )}
                  {m.text && <span>{m.text.split(/(@[\w\-\u4e00-\u9fff]+)/g).map((part, i) => part.startsWith('@') ? <mark className="chat-mention" key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>)}</span>}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="chat-composer" onPaste={onPaste}>
        {replyTo && (
          <div className="chat-replying">
            <span>回复 <strong>{replyTo.nick}</strong>：{replyTo.text || (replyTo.image ? '[图片]' : `[文件] ${replyTo.file?.name || ''}`)}</span>
            <button onClick={() => setReplyTo(null)} aria-label="取消回复">×</button>
          </div>
        )}
        <textarea
          className="chat-input"
          placeholder="输入消息…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-composer-footer">
          <span className="chat-input-hint">Enter 发送 · Shift+Enter 换行 · 支持粘贴或拖入文件</span>
          <div className="chat-composer-actions">
            <input ref={fileRef} type="file" multiple
              accept="image/*,.txt,.text,.md,.markdown,.rst,.adoc,.csv,.tsv,.log,.json,.json5,.jsonl,.yaml,.yml,.toml,.ini,.conf,.cfg,.properties,.env,.xml,.xsl,.xsd,.sql,.js,.mjs,.cjs,.jsx,.ts,.tsx,.vue,.svelte,.astro,.py,.rb,.php,.java,.go,.rs,.c,.h,.cc,.cpp,.hpp,.cs,.swift,.kt,.kts,.sh,.bash,.zsh,.fish,.bat,.cmd,.ps1,.psm1,.html,.htm,.css,.scss,.less,.graphql,.gql,.tex,.rtf,.svg,.zip,.7z,.rar,.tar,.gz,.tgz,.bz2,.xz"
              style={{ display: 'none' }} onChange={(e) => { const files = e.target.files; e.target.value = ''; if (files?.length) sendFiles(files); }} />
            <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display: 'none' }}
              onChange={(e) => { const files = e.target.files; e.target.value = ''; if (files?.length) sendFolder(files); }} />
            <div className="chat-attach-wrap" onMouseDown={(e) => e.stopPropagation()}>
              <button className="btn chat-img-btn" title="发送文件或文件夹" aria-label="添加附件" onClick={() => setAttachMenuOpen((open) => !open)}>📎</button>
              {attachMenuOpen && (
                <div className="chat-attach-menu">
                  <button onClick={() => { setAttachMenuOpen(false); fileRef.current?.click(); }}>选择文件或图片</button>
                  <button onClick={() => { setAttachMenuOpen(false); folderRef.current?.click(); }}>选择文件夹</button>
                </div>
              )}
            </div>
            <button className="btn primary chat-send-btn" onClick={send} disabled={!serverUrl || status !== 'connected' || sending}>
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>

      {storageOpen && (
        <div className="modal-mask" onClick={() => setStorageOpen(false)}>
          <div className="modal chat-storage-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>聊天记录与缓存管理</h3>
              <button className="btn small" onClick={() => setStorageOpen(false)}>关闭</button>
            </div>
            <div className="modal-body">
              <p className="hint">数据仅保存在这台 Windows 共享主机。删除后无法恢复。</p>
              {storage?.locations && (
                <div className="chat-storage-locations">
                  <strong>本机存储位置</strong>
                  <div>数据目录：<code>{storage.locations.dataDir}</code></div>
                  <div>聊天记录：<code>{storage.locations.messagesFile}</code></div>
                  <div>图片缓存：<code>{storage.locations.imagesDir}</code></div>
                  <div>文件缓存：<code>{storage.locations.filesDir}</code></div>
                </div>
              )}
              <div className="chat-storage-grid">
                <StorageItem label="聊天消息" value={storage ? `${storage.messageCount} 条 · ${formatBytes(storage.historyBytes)}` : '—'} />
                <StorageItem label="图片缓存" value={storage ? `${storage.imageCount} 个 · ${formatBytes(storage.imageBytes)}` : '—'} />
                <StorageItem label="文件缓存" value={storage ? `${storage.fileCount} 个 · ${formatBytes(storage.fileBytes)}` : '—'} />
                <StorageItem label="合计占用" value={storage ? formatBytes(storage.totalBytes) : '—'} />
              </div>
              <div className="chat-storage-actions">
                <button className="btn" disabled={storageBusy} onClick={loadStorage}>刷新统计</button>
                <button className="btn" disabled={storageBusy} onClick={() => clearStorage('messages')}>清空聊天记录</button>
                <button className="btn" disabled={storageBusy} onClick={() => clearStorage('orphaned')}>清理无引用缓存</button>
                <button className="btn danger" disabled={storageBusy} onClick={() => clearStorage('all')}>全部清空</button>
                <button className="btn" onClick={async () => { const data = await window.api.chat.exportHistory({ format: 'json' }); await navigator.clipboard.writeText(data); showToast('JSON 历史已复制'); }}>导出 JSON</button>
                <button className="btn" onClick={async () => { const data = await window.api.chat.exportHistory({ format: 'md' }); await navigator.clipboard.writeText(data); showToast('Markdown 历史已复制'); }}>导出 Markdown</button>
                <button className="btn" onClick={async () => { const raw = window.prompt('输入要删除的消息 ID（逗号分隔）'); if (!raw) return; const r = await window.api.chat.deleteMessages(raw.split(',').map((x) => Number(x.trim())).filter(Number.isInteger)); showToast(`已删除 ${r.count} 条消息`); }}>按 ID 删除消息</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {previewImage && (
        <div className="chat-preview-mask" role="presentation" onClick={() => setPreviewImage(null)}>
          <div className="chat-preview" role="dialog" aria-modal="true" aria-label="图片预览" onClick={(e) => e.stopPropagation()}>
            <div className="chat-preview-head">
              <div>
                <strong>{previewImage.nick || '群聊图片'}</strong>
                <span>{previewImage.ts ? new Date(previewImage.ts).toLocaleString('zh-CN') : ''}</span>
              </div>
              <div className="chat-preview-actions">
                <button className="btn small" onClick={() => copyImage(previewImage.url)}>复制图片</button>
                <a className="btn small" href={previewImage.url} download>下载</a>
                <button className="btn small primary" onClick={() => setPreviewImage(null)}>关闭</button>
              </div>
            </div>
            <div className="chat-preview-stage">
              <img src={previewImage.url} alt="群聊图片预览" />
            </div>
            <span className="chat-preview-hint">按 Esc 或点击空白区域关闭</span>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.ok ? '' : 'err'}`}>{toast.msg}</div>}
    </div>
  );
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function StorageItem({ label, value }) {
  return <div className="chat-storage-item"><span>{label}</span><strong>{value}</strong></div>;
}

async function collectEntryFiles(entry, output, parentPath = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    Object.defineProperty(file, 'relativePath', { value: `${parentPath}${entry.name}`, enumerable: false });
    output.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  while (true) {
    const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) break;
    for (const child of entries) await collectEntryFiles(child, output, `${parentPath}${entry.name}/`);
  }
}
