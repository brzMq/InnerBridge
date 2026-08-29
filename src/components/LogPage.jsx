import React, { useEffect, useRef, useState } from 'react';

/** ISO 时间戳 → 本地可读时间戳 YYYY-MM-DD HH:mm:ss.SSS */
function fmtTs(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

const MAX_VIEW = 2000; // 界面最多保留的日志条数

export default function LogPage() {
  const [logs, setLogs] = useState([]);
  const [live, setLive] = useState(true); // 实时刷新开关
  const [autoScroll, setAutoScroll] = useState(true); // 自动滚动开关
  const liveRef = useRef(live);
  const listRef = useRef(null);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // 首次加载历史 + 订阅实时日志
  useEffect(() => {
    let cancelled = false;
    window.api.logs
      .history()
      .then((h) => {
        if (!cancelled && Array.isArray(h)) setLogs(h.slice(-MAX_VIEW));
      })
      .catch(() => {});

    const off = window.api.logs.onLog((entry) => {
      if (!liveRef.current) return; // 实时刷新关闭时丢弃新事件（视图冻结）
      setLogs((prev) => {
        const next = prev.length >= MAX_VIEW ? prev.slice(prev.length - MAX_VIEW + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    });
    return () => {
      cancelled = true;
      off && off();
    };
  }, []);

  // 重新打开实时刷新：补齐离线期间的日志
  const toggleLive = async (v) => {
    setLive(v);
    if (v) {
      try {
        const h = await window.api.logs.history();
        if (Array.isArray(h)) setLogs(h.slice(-MAX_VIEW));
      } catch {
        /* ignore */
      }
    }
  };

  // 自动滚动到底部
  useEffect(() => {
    if (live && autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, live, autoScroll]);

  const clearView = () => setLogs([]);

  // 复制当前视图日志（含时间戳/级别/来源/内容）
  const copyLogs = async () => {
    const text = logs
      .map((e) => `${fmtTs(e.ts)} [${e.level}] ${e.source}: ${e.message}`)
      .join('\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      alert('日志已复制（' + logs.length + ' 条）');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      alert('日志已复制（' + logs.length + ' 条）');
    }
  };

  return (
    <div className="page log-page">
      <div className="page-head">
        <div>
          <h2>运行日志</h2>
          <p className="sub">带时间戳的过程记录（应用启动、聊天服务、共享、挂载、清单同步等）</p>
        </div>
        <div className="head-actions">
          <label className="switch" title="关闭后日志视图冻结，不再实时更新">
            <input type="checkbox" checked={live} onChange={(e) => toggleLive(e.target.checked)} />
            <span>实时刷新</span>
          </label>
          <label className="switch" title="新日志自动滚动到底部">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            <span>自动滚动</span>
          </label>
          <button className="btn ghost" onClick={copyLogs} disabled={!logs.length}>
            复制日志
          </button>
          <button className="btn ghost" onClick={clearView}>
            清空显示
          </button>
        </div>
      </div>

      <div className="log-list" ref={listRef}>
        {logs.length === 0 ? (
          <div className="empty">
            <p>暂无日志</p>
            <p className="sub">操作共享、挂载或同步清单后这里会实时出现记录</p>
          </div>
        ) : (
          logs.map((e) => (
            <div className={`log-row lvl-${e.level}`} key={e.seq}>
              <span className="log-ts mono">{fmtTs(e.ts)}</span>
              <span className={`log-lvl log-lvl-${e.level}`}>{e.level}</span>
              <span className="log-src">{e.source}</span>
              <span className="log-msg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
