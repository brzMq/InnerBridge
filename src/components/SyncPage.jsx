/* global setInterval, clearInterval */
import React, { useEffect, useState, useCallback } from 'react';

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const ROLE_LABEL = { off: '未启用', master: '主端', slave: '从端' };

export default function SyncPage() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState([]);

  const show = useCallback((text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await window.api.sync.state();
      setState(s);
    } catch (e) {
      show(String(e.message || e), false);
    }
  }, [show]);

  useEffect(() => {
    refresh();
    const off = window.api.sync.onState((s) => setState(s));
    const timer = setInterval(refresh, 3000);
    return () => { clearInterval(timer); off?.(); };
  }, [refresh]);

  const config = state?.config || {};
  const status = state?.status || {};
  const history = state?.history || [];

  const pickDir = async (field) => {
    const dir = await window.api.sync.pickDir();
    if (!dir) return;
    const next = await window.api.sync.setConfig({ [field]: dir });
    setState((s) => ({ ...s, config: next }));
    show(`已选择目录：${dir}`);
  };

  const setField = async (field, value) => {
    const next = await window.api.sync.setConfig({ [field]: value });
    setState((s) => ({ ...s, config: next }));
  };

  const start = async () => {
    setBusy(true);
    try {
      await window.api.sync.start();
      show('同步已启动');
      refresh();
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await window.api.sync.stop();
      show('同步已停止');
      refresh();
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await window.api.sync.runNow();
      if (r.ok) show(`同步完成：推送 ${r.pushed || 0}，回收 ${r.trashed || 0}，失败 ${r.failed || 0}`);
      else show(r.error || '同步失败', false);
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const openTrash = async () => {
    const list = await window.api.sync.trash();
    setTrash(list);
    setShowTrash(true);
  };

  const restore = async (stamp, rel) => {
    try {
      await window.api.sync.restore({ stamp, path: rel });
      show(`已恢复 ${rel}`);
      setTrash(await window.api.sync.trash());
    } catch (e) {
      show(String(e.message || e), false);
    }
  };

  const purgeAll = async () => {
    try {
      const r = await window.api.sync.purgeTrash({ all: true });
      show(`已清理 ${r.purged.length} 个回收批次`);
      setTrash(await window.api.sync.trash());
    } catch (e) {
      show(String(e.message || e), false);
    }
  };

  const resetIndex = async () => {
    try {
      await window.api.sync.resetIndex();
      show('已清空索引，下次同步将全量比对');
    } catch (e) {
      show(String(e.message || e), false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>文件夹同步</h2>
          <p className="sub">指定文件夹的双端实时同步（单向主从，主端变更推送到从端）</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={openTrash} disabled={!config.slaveRoot}>回收区</button>
          <button className="btn ghost" onClick={resetIndex} disabled={busy}>清空索引</button>
          <button className="btn" onClick={runNow} disabled={busy || config.role !== 'master'}>立即同步</button>
          {status.running ? (
            <button className="btn danger" onClick={stop} disabled={busy}>停止</button>
          ) : (
            <button className="btn primary" onClick={start} disabled={busy || config.role === 'off'}>启动</button>
          )}
        </div>
      </div>

      <div className="settings">
        <div className="setting-row">
          <span className="k">角色</span>
          <div className="seg">
            {['off', 'master', 'slave'].map((r) => (
              <button key={r} className={config.role === r ? 'on' : ''} onClick={() => setField('role', r)}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          <span className="hint">
            {config.role === 'master' && '主端：监听目录变更，推送到从端；删除的文件在从端移入回收区'}
            {config.role === 'slave' && '从端：接收主端推送，本地多余的文件在全量校验时移入回收区'}
            {config.role === 'off' && '选择角色后开始配置'}
          </span>
        </div>

        {config.role !== 'off' && (
          <>
            <div className="setting-row">
              <span className="k">{config.role === 'master' ? '主端目录' : '从端目录'}</span>
              <input
                className="text-input"
                value={config.role === 'master' ? config.masterRoot : config.slaveRoot}
                placeholder="点击右侧按钮选择目录"
                readOnly
                style={{ flex: 1 }}
              />
              <button className="btn small" onClick={() => pickDir(config.role === 'master' ? 'masterRoot' : 'slaveRoot')}>选择</button>
            </div>

            {config.role === 'master' && (
              <>
                <div className="setting-row">
                  <span className="k">从端地址</span>
                  <input
                    className="text-input"
                    value={config.peerAddress}
                    placeholder="如 192.168.5.50"
                    onChange={(e) => setField('peerAddress', e.target.value.trim())}
                    style={{ width: 180 }}
                  />
                  <span className="k">端口</span>
                  <input
                    className="text-input"
                    type="number"
                    value={config.peerPort}
                    onChange={(e) => setField('peerPort', Number(e.target.value))}
                    style={{ width: 80 }}
                  />
                </div>
                <div className="setting-row">
                  <span className="k">回收保留</span>
                  <input
                    className="text-input"
                    type="number"
                    value={config.trashRetentionDays}
                    onChange={(e) => setField('trashRetentionDays', Number(e.target.value))}
                    style={{ width: 80 }}
                  />
                  <span className="hint">天；主端删除的文件在从端先入回收区，超期自动清理</span>
                </div>
              </>
            )}

            {config.role === 'slave' && (
              <p className="hint" style={{ padding: '0 12px' }}>
                从端监听 <code className="mono">{config.peerPort || 7892}</code> 端口，需在防火墙放行。
                接收的文件直接落到从端目录；删除的文件移入 <code className="mono">.innernet-trash/</code>。
              </p>
            )}
          </>
        )}
      </div>

      {config.role !== 'off' && (
        <div className="sync-status">
          <div className="sync-status-row">
            <span className={`badge ${status.running ? 'ok' : 'warn-text'}`}>
              {status.running ? '同步中' : '空闲'}
            </span>
            {status.currentFile && <span className="mono">正在推送：{status.currentFile}</span>}
            {status.pending > 0 && <span className="hint">剩余 {status.pending}</span>}
          </div>
          <div className="sync-status-row">
            <span className="hint">已同步文件数：{status.fileCount || 0}</span>
            {status.lastSyncAt && <span className="hint">上次同步：{new Date(status.lastSyncAt).toLocaleString()}</span>}
            {status.lastError && <span className="hint warn-text">最近错误：{status.lastError}</span>}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="sync-history">
          <h3>同步历史</h3>
          <div className="log-list">
            {history.map((h, i) => (
              <div key={i} className="log-item">
                <span className="log-time">{new Date(h.at).toLocaleTimeString()}</span>
                <span className={`log-level ${h.ok ? 'info' : 'error'}`}>{h.ok ? '✓' : '✗'}</span>
                <span className="log-msg">
                  {h.kind === 'cycle' ? h.message : `${h.kind} ${h.path}${h.message ? ` — ${h.message}` : ''}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showTrash && (
        <Modal title="回收区" onClose={() => setShowTrash(false)}>
          {trash.length === 0 ? (
            <p className="empty">回收区为空</p>
          ) : (
            <>
              <div className="modal-foot" style={{ justifyContent: 'flex-start', marginBottom: 12 }}>
                <button className="btn small danger" onClick={purgeAll}>清空全部</button>
              </div>
              <div className="trash-list">
                {trash.map((batch) => (
                  <div key={batch.stamp} className="trash-batch">
                    <div className="trash-batch-head">
                      <strong>{new Date(batch.at).toLocaleString()}</strong>
                      <span className="hint">{batch.count} 个文件</span>
                    </div>
                    {batch.files.map((rel) => (
                      <div key={rel} className="trash-item">
                        <code className="mono">{rel}</code>
                        <button className="btn small" onClick={() => restore(batch.stamp, rel)}>恢复</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}

      {msg && <div className={`toast ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}
