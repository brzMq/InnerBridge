import React, { useCallback, useEffect, useState } from 'react';

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

const DEFAULT_HOST = '192.168.5.50';

const newId = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

// 挂载目录清理结果文案：目录非空时必须说清楚，避免用户以为残留文件已被删掉
function mountCleanupText(r) {
  if (r?.mountPointRemovalReason === 'not-empty') return '，挂载目录非空已保留（请手动清理）';
  if (r?.mountPointRemoved) return '，挂载目录已清理';
  return '';
}

// 按「主机 + 共享名」合并清单：保留本机已填的口令和挂载点，其他主机的记录不受影响。
// 对端离线或清单缺项时，已有记录不会被清空 —— SMB 密码只存在本机，不会从网络回来。
function mergeMounts(existing, targetHost, incoming) {
  const others = existing.filter((m) => m.host !== targetHost);
  const previous = new Map(
    existing.filter((m) => m.host === targetHost).map((m) => [m.shareName, m])
  );
  const merged = incoming.map((x) => {
    const prev = previous.get(x.shareName);
    return {
      id: prev?.id || newId(),
      host: targetHost,
      shareName: x.shareName,
      account: x.account || 'share',
      password: prev?.password || '',
      mountPoint: prev?.mountPoint || '',
    };
  });
  return [...others, ...merged];
}

function ApiSyncPanel({ onImported }) {
  const [host, setHost] = useState(DEFAULT_HOST);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const show = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  const pull = async () => {
    setBusy(true);
    try {
      const target = host.trim();
      const list = await window.api.shares.apiPull({ host: target });
      if (!list.length) throw new Error('对端没有可同步的共享');
      const next = mergeMounts(await window.api.mounts.list(), target, list);
      await window.api.mounts.save(next);
      const synced = next.filter((m) => m.host === target);
      const needPassword = synced.filter((m) => !m.password).length;
      show(
        `已从 ${target} 同步 ${synced.length} 个共享` +
          (needPassword ? `，其中 ${needPassword} 个需要先填写密码` : '')
      );
      onImported && onImported();
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-panel">
      <div className="sync-head">
        <div>
          <h3>同步共享清单</h3>
          <p className="sub">用已配对设备的 Ed25519 签名拉取 Windows 端共享清单</p>
        </div>
      </div>
      <div className="sync-body">
        <div className="sync-form">
          <input
            className="text-input"
            placeholder="Windows 主机 IP"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            style={{ width: 150 }}
          />
          <button className="btn small primary" onClick={pull} disabled={busy || !host.trim()}>
            {busy ? '同步中…' : '⌁ 拉取共享清单'}
          </button>
        </div>
        <p className="hint">
          请先在设备中心完成配对。清单只同步共享名和账号，SMB 密码保留在本机，不会经网络传输。
        </p>
      </div>
      {msg && <div className={`toast ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}

export default function MountManager({ sys }) {
  const [mounts, setMounts] = useState([]);
  const [mode, setMode] = useState('autofs'); // autofs(LaunchAgent) | manual
  const [root, setRoot] = useState(''); // 聚合根目录
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const home = sys.home || '';

  const show = useCallback((text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  }, []);

  const normalizeRoot = useCallback(
    (m) => (root ? m.map((x) => ({ ...x, mountPoint: x.mountPoint || `${root}/${x.shareName}` })) : m),
    [root]
  );

  const resolvedMountPoint = useCallback(
    (m) => m.mountPoint || `${root || `${home}/Shared`}/${m.shareName}`,
    [home, root]
  );

  const refresh = useCallback(async () => {
    const list = await window.api.mounts.list();
    setMounts(list);
  }, []);

  useEffect(() => {
    refresh().catch((e) => show(String(e.message || e), false));
  }, [refresh, show]);

  const applyAutofs = async () => {
    if (!mounts.length) return show('请先添加共享', false);
    setBusy(true);
    try {
      const norm = normalizeRoot(mounts);
      const res = await window.api.mounts.applyAutofs(norm);
      setMounts(res.mounts);
      if (res.pending?.length) {
        show(`自动挂载已启用；已挂载 ${res.mounted.length} 个，另有 ${res.pending.length} 个等待网络恢复。`);
      } else {
        show(`自动挂载已启用并验证，已挂载 ${res.mounted.length} 个共享。`);
      }
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const mountAll = async () => {
    if (!mounts.length) return show('请先添加共享', false);
    setBusy(true);
    let done = 0;
    let already = 0;
    try {
      for (const m of normalizeRoot(mounts)) {
        try {
          const result = await window.api.mounts.mountOne(m);
          if (result?.alreadyMounted) already++;
          else done++;
        } catch (e) {
          show(`「${m.shareName}」挂载失败: ${String(e.message || e)}`, false);
        }
      }
      if (done || already) {
        const parts = [];
        if (done) parts.push(`新挂载 ${done} 个`);
        if (already) parts.push(`${already} 个原本已挂载`);
        show(`${parts.join('，')}，位置：${root || '~/Shared'}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const mountOneItem = async (m) => {
    setBusy(true);
    try {
      const result = await window.api.mounts.mountOne(m);
      show(result?.alreadyMounted ? `「${m.shareName}」已经挂载，无需重复操作` : `已挂载 ${m.shareName}`);
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const unmountOne = async (m) => {
    setBusy(true);
    try {
      const r = await window.api.mounts.unmount(resolvedMountPoint(m));
      const cleanup = mountCleanupText(r);
      if (r && r.ok === false && r.reason === 'not-mounted') {
        show(`「${m.shareName}」未挂载${cleanup || '，无需卸载'}`);
      } else {
        show(`已卸载 ${m.shareName}${cleanup}`);
      }
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const saveAndReload = async (next) => {
    const list = await window.api.mounts.save(normalizeRoot(next));
    setMounts(list);
  };

  const removeMount = async (m) => {
    setBusy(true);
    try {
      // 先卸载并清理空挂载目录，再删记录。目录非空时保留并提示，绝不递归删除。
      // 对端离线导致卸载失败也不阻止移除记录，否则离线共享永远删不掉。
      let cleanup = '';
      try {
        cleanup = mountCleanupText(await window.api.mounts.unmount(resolvedMountPoint(m)));
      } catch {
        cleanup = '';
      }
      const next = mounts.filter((x) => x.id !== m.id);
      await saveAndReload(next);
      show(`已移除 ${m.shareName}${cleanup}`);
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const importJSON = async (text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('JSON 解析失败');
    }
    const arr = Array.isArray(data) ? data : [data];
    const incoming = arr.filter((x) => x.shareName);
    if (!incoming.length) throw new Error('清单里没有有效的共享');
    // 与 API 同步走同一套合并规则：已有记录的口令和挂载点不会被覆盖
    const target = incoming[0].host || DEFAULT_HOST;
    const next = mergeMounts(await window.api.mounts.list(), target, incoming);
    await saveAndReload(next);
    setShowImport(false);
    show(`已导入 ${incoming.length} 个共享`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>聚合挂载</h2>
          <p className="sub">把 Windows 的多个共享，聚合挂载到本机一个文件夹下</p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => setShowImport(true)}>导入清单</button>
          <button className="btn primary" onClick={() => setShowAdd(true)}>＋ 添加共享</button>
        </div>
      </div>

      <div className="settings">
        <div className="setting-row">
          <span className="k">聚合根目录</span>
          <input
            className="text-input"
            value={root}
            placeholder={`默认 ${home}/Shared`}
            onChange={(e) => setRoot(e.target.value.replace(/\/+$/, ''))}
          />
          <span className="hint">每个共享挂载为根目录下的子文件夹</span>
        </div>
        <div className="setting-row">
          <span className="k">挂载方式</span>
          <div className="seg">
            <button className={mode === 'autofs' ? 'on' : ''} onClick={() => setMode('autofs')}>
              自动（后台守护）
            </button>
            <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>
              手动 (mount_smbfs)
            </button>
          </div>
          <span className="hint">
            {mode === 'autofs'
              ? '登录自动挂载，网络恢复后 30 秒内自动重挂（无需管理员密码）'
              : '手动挂载，重启后需再次挂载'}
          </span>
        </div>
      </div>

      <ApiSyncPanel onImported={refresh} />

      {mounts.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🔗</div>
          <p>还没有挂载项</p>
          <p className="sub">点「导入清单」粘贴 Windows 端导出的 JSON，或手动添加</p>
        </div>
      ) : (
        <>
          <div className="mount-list">
            {mounts.map((m) => (
              <div className="mount-item" key={m.id}>
                <div className="mount-info">
                  <span className="dir-icon">📁</span>
                  <div>
                    <h3>{m.shareName}</h3>
                    <p className="path mono">
                      smb://{m.account}@{m.host}/{m.shareName} → {resolvedMountPoint(m)}
                    </p>
                  </div>
                </div>
                <div className="mount-actions">
                  {mode === 'manual' && (
                    <button className="btn small" onClick={() => mountOneItem(m)} disabled={busy}>
                      挂载
                    </button>
                  )}
                  <button className="btn small" onClick={() => unmountOne(m)} disabled={busy}>
                    卸载
                  </button>
                  <button className="btn small danger" onClick={() => removeMount(m)} disabled={busy}>
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="apply-bar">
            {mode === 'autofs' ? (
              <button className="btn primary big" onClick={applyAutofs} disabled={busy}>
                {busy ? '配置中…' : '⚙ 启用自动挂载并立即验证'}
              </button>
            ) : (
              <button className="btn primary big" onClick={mountAll} disabled={busy}>
                {busy ? '挂载中…' : '⌁ 挂载全部'}
              </button>
            )}
            <span className="hint">
              {mode === 'autofs'
                ? '使用当前用户的后台任务，不修改 SIP 保护的系统文件'
                : '逐个挂载到聚合目录，立即生效'}
            </span>
          </div>
        </>
      )}

      {showAdd && (
        <Modal title="添加共享" onClose={() => setShowAdd(false)}>
          <AddMountForm
            root={root}
            onDone={(m) => {
              setShowAdd(false);
              const next = [...mounts, m];
              saveAndReload(next);
              show(`已添加 ${m.shareName}`);
            }}
            onCancel={() => setShowAdd(false)}
          />
        </Modal>
      )}

      {showImport && (
        <Modal title="导入共享清单" onClose={() => setShowImport(false)}>
          <ImportForm onDone={importJSON} onCancel={() => setShowImport(false)} />
        </Modal>
      )}

      {msg && <div className={`toast ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}

function AddMountForm({ root, onDone, onCancel }) {
  const [host, setHost] = useState(DEFAULT_HOST);
  const [shareName, setShareName] = useState('');
  const [account, setAccount] = useState('share');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  const submit = () => {
    if (!shareName.trim()) return setErr('请填写共享名');
    onDone({
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      host: host.trim() || DEFAULT_HOST,
      shareName: shareName.trim(),
      account: account.trim() || 'share',
      password,
      mountPoint: '',
    });
  };

  return (
    <div className="form">
      <label>
        主机 IP
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder={DEFAULT_HOST} />
      </label>
      <label>
        共享名
        <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder="Windows 端创建的共享名" />
      </label>
      <div className="grid2">
        <label>
          账号
          <input value={account} onChange={(e) => setAccount(e.target.value)} />
        </label>
        <label>
          密码
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空存钥匙串时再填" />
        </label>
      </div>
      <p className="hint">
        挂载点：{root ? `${root}/${shareName || '<共享名>'}` : `~/Shared/${shareName || '<共享名>'}`}
      </p>
      {err && <p className="error">{err}</p>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn primary" onClick={submit}>添加</button>
      </div>
    </div>
  );
}

function ImportForm({ onDone, onCancel }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!text.trim()) return setErr('请粘贴 JSON');
    try {
      await onDone(text);
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  return (
    <div className="form">
      <label>
        Windows 端导出的 JSON 清单
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='[{"shareName":"设计资料","account":"share_ab12cd","password":"..."}]'
        />
      </label>
      {err && <p className="error">{err}</p>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn primary" onClick={submit}>导入</button>
      </div>
    </div>
  );
}
