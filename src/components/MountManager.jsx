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

function ApiSyncPanel({ host, setHost, hostStatus, knownHosts, onEditHost, onRemoveHost, onImported, home = '', root = '' }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const show = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  const defaultMountPoint = (shareName) => {
    const base = root || `${home}/Shared`;
    return `${base}/${shareName}`;
  };

  const pull = async () => {
    setBusy(true);
    try {
      const target = host.trim();
      const list = await window.api.shares.apiPull({ host: target });
      if (!list.length) throw new Error('对端没有可同步的共享');
      const existing = await window.api.mounts.list();
      // 同步时把对端已删除的旧记录连同本地空目录一起清掉：
      // 旧记录不再出现在新清单里 → 卸载并尝试清空挂载目录，目录非空则保留并提示
      const oldForHost = existing.filter((m) => m.host === target);
      const newShareNames = new Set(list.map((x) => x.shareName));
      const stale = oldForHost.filter((m) => !newShareNames.has(m.shareName));
      let cleaned = 0;
      let keptBusy = 0;
      for (const m of stale) {
        try {
          const r = await window.api.mounts.unmount(m.mountPoint || defaultMountPoint(m.shareName));
          if (r?.mountPointRemoved) cleaned += 1;
          else if (r?.mountPointRemovalReason === 'not-empty') keptBusy += 1;
        } catch { /* 未挂载/离线/失败都放过，目录是否留下由用户处理 */ }
      }
      const next = mergeMounts(existing, target, list);
      await window.api.mounts.save(next);
      const synced = next.filter((m) => m.host === target);
      const needPassword = synced.filter((m) => !m.password && !hostStatus?.hasPassword).length;
      const parts = [`已从 ${target} 同步 ${synced.length} 个共享`];
      if (stale.length) parts.push(`清理 ${cleaned} 个失效记录${keptBusy ? `（${keptBusy} 个目录非空已保留）` : ''}`);
      if (needPassword) parts.push(`${needPassword} 个需要填写密码`);
      show(parts.join('，'));
      onImported && onImported();
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings host-sync-panel">
      <div className="setting-row host-sync-row">
        <span className="k">Windows 主机</span>
        <input
          className="text-input"
          list="known-windows-hosts"
          placeholder="主机 IP"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
        <datalist id="known-windows-hosts">
          {knownHosts.map((item) => <option value={item} key={item} />)}
        </datalist>
        <span className={hostStatus?.hasPassword ? 'badge ok' : 'badge warn'}>
          {hostStatus?.hasPassword
            ? `已设密码${hostStatus.updatedAt ? ` · ${new Date(hostStatus.updatedAt).toLocaleDateString()}` : ''}`
            : '未设统一密码'}
        </span>
        <button className="btn small" disabled={!host.trim()} onClick={() => onEditHost(host.trim(), Boolean(hostStatus?.hasPassword))}>
          {hostStatus?.hasPassword ? '更新密码' : '设置密码'}
        </button>
        {hostStatus?.hasPassword && (
          <button className="btn small danger" onClick={() => onRemoveHost(host.trim())}>删除密码</button>
        )}
        <button className="btn small primary" onClick={pull} disabled={busy || !host.trim()}>
          {busy ? '拉取中…' : '拉取共享清单'}
        </button>
      </div>
      <p className="hint host-sync-hint">
        配对后可同步该主机的共享名和账号；统一密码仅保存在本机，并自动用于该主机的所有共享。
      </p>
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
  const [editing, setEditing] = useState(null);
  const [hostPasswords, setHostPasswords] = useState({}); // { [host]: { hasPassword, updatedAt } }
  const [syncHost, setSyncHost] = useState(DEFAULT_HOST);
  const [editingHost, setEditingHost] = useState(null); // { host, currentPassword } | null
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
    const [list, hosts] = await Promise.all([window.api.mounts.list(), window.api.host.list()]);
    setMounts(list);
    setHostPasswords(Object.fromEntries(hosts.map((h) => [h.host, h])));
    setSyncHost((current) => {
      const known = list.find((item) => item.host)?.host || hosts[0]?.host;
      return current === DEFAULT_HOST && known ? known : current;
    });
  }, []);

  const refreshMountStatus = useCallback(async () => {
    setMounts(await window.api.mounts.list());
  }, []);

  useEffect(() => {
    refresh().catch((e) => show(String(e.message || e), false));
  }, [refresh, show]);

  // 后台守护可能在网络恢复后自行完成挂载，页面停留期间定时同步真实状态。
  useEffect(() => {
    const timer = globalThis.setInterval(() => refreshMountStatus().catch(() => {}), 10000);
    return () => globalThis.clearInterval(timer);
  }, [refreshMountStatus]);

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
      await refreshMountStatus().catch(() => {});
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
      await refreshMountStatus().catch(() => {});
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
      await refreshMountStatus().catch(() => {});
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
      await refreshMountStatus().catch(() => {});
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

  const removeHostPassword = async (host) => {
    await window.api.host.remove({ host });
    show(`已移除 ${host} 的统一密码`);
    refresh();
  };

  const knownHosts = [...new Set([
    ...Object.keys(hostPasswords),
    ...mounts.map((item) => item.host),
  ].filter(Boolean))];
  const selectedHostStatus = hostPasswords[syncHost.trim()];

  return (
    <div className="page app-page-surface">
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
          <div className="mount-mode-controls">
            <div className="seg">
              <button className={mode === 'autofs' ? 'on' : ''} onClick={() => setMode('autofs')}>
                自动（后台守护）
              </button>
              <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>
                手动 (mount_smbfs)
              </button>
            </div>
            {mode === 'autofs' ? (
              <button className="btn small primary" onClick={applyAutofs} disabled={busy}>
                {busy ? '配置中…' : '启用并验证'}
              </button>
            ) : (
              <button className="btn small primary" onClick={mountAll} disabled={busy}>
                {busy ? '挂载中…' : '挂载全部'}
              </button>
            )}
          </div>
          <span className="hint">
            {mode === 'autofs'
              ? '登录自动挂载，网络恢复后 30 秒内自动重挂（无需管理员密码）'
              : '手动挂载，重启后需再次挂载'}
          </span>
        </div>
      </div>

      <ApiSyncPanel
        host={syncHost}
        setHost={setSyncHost}
        hostStatus={selectedHostStatus}
        knownHosts={knownHosts}
        onEditHost={(host, hasPassword) => setEditingHost({ host, hasPassword })}
        onRemoveHost={removeHostPassword}
        onImported={refresh}
        home={home}
        root={root}
      />

      {mounts.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🔗</div>
          <p>还没有挂载项</p>
          <p className="sub">点「导入清单」粘贴 Windows 端导出的 JSON，或手动添加</p>
        </div>
      ) : (
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
                    {!m.password && hostPasswords[m.host]?.hasPassword && (
                      <p className="hint">本机无独立密码，将使用主机 {m.host} 的统一密码</p>
                    )}
                    {!m.password && !hostPasswords[m.host]?.hasPassword && (
                      <p className="hint warn-text">未设置密码且该主机也无统一密码，挂载会失败，点「编辑」填写</p>
                    )}
                  </div>
                </div>
                <span className={`badge mount-status ${m.mounted ? 'ok' : 'neutral'}`}>
                  {m.mounted ? '已挂载' : '未挂载'}
                </span>
                <div className="mount-actions">
                  {mode === 'manual' && (
                    <button className="btn small" onClick={() => mountOneItem(m)} disabled={busy}>
                      挂载
                    </button>
                  )}
                  <button className="btn small" onClick={() => unmountOne(m)} disabled={busy}>
                    卸载
                  </button>
                  <button className="btn small" onClick={() => setEditing(m)} disabled={busy}>
                    编辑
                  </button>
                  <button className="btn small danger" onClick={() => removeMount(m)} disabled={busy}>
                    移除
                  </button>
                </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <Modal title="添加共享" onClose={() => setShowAdd(false)}>
          <MountForm
            root={root}
            onSubmit={(m) => {
              setShowAdd(false);
              saveAndReload([...mounts, m]);
              show(`已添加 ${m.shareName}`);
            }}
            onCancel={() => setShowAdd(false)}
          />
        </Modal>
      )}

      {editing && (
        <Modal title="编辑共享" onClose={() => setEditing(null)}>
          <MountForm
            root={root}
            initial={editing}
            hostHasPassword={Boolean(hostPasswords[editing.host]?.hasPassword)}
            onSubmit={(m) => {
              setEditing(null);
              saveAndReload(mounts.map((x) => (x.id === m.id ? m : x)));
              show(`已保存 ${m.shareName}`);
            }}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}

      {editingHost && (
        <Modal title={`${editingHost.hasPassword ? '更新' : '设置'}主机统一密码`} onClose={() => setEditingHost(null)}>
          <HostPasswordForm
            host={editingHost.host}
            hasPassword={editingHost.hasPassword}
            onSubmit={async (password) => {
              const result = await window.api.host.set({ host: editingHost.host, password });
              setEditingHost(null);
              show(
                result?.propagated
                  ? `已为 ${editingHost.host} 设置统一密码，覆盖 ${result.propagated} 个共享`
                  : `已为 ${editingHost.host} 设置统一密码`
              );
              refresh();
            }}
            onCancel={() => setEditingHost(null)}
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

function HostPasswordForm({ host, hasPassword, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const submit = () => {
    if (!password) return setErr('请输入密码');
    onSubmit(password);
  };
  return (
    <div className="form">
      <p className="hint">主机：<code className="mono">{host}</code></p>
      <label>新密码<input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={hasPassword ? '新密码将覆盖原值' : '该主机的统一密码'} /></label>
      {hasPassword && <p className="hint warn-text">更新后会覆盖该主机所有现有共享的密码。</p>}
      {err && <p className="error">{err}</p>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn primary" onClick={submit}>保存</button>
      </div>
    </div>
  );
}

function MountForm({ root, initial = null, hostHasPassword = false, onSubmit, onCancel }) {
  const isEdit = Boolean(initial);
  const [host, setHost] = useState(initial?.host || DEFAULT_HOST);
  const [shareName, setShareName] = useState(initial?.shareName || '');
  const [account, setAccount] = useState(initial?.account || 'share');
  const [password, setPassword] = useState(initial?.password || '');
  const [err, setErr] = useState('');

  const submit = () => {
    if (!shareName.trim()) return setErr('请填写共享名');
    if (!host.trim()) return setErr('请填写主机 IP');
    onSubmit({
      id: initial?.id || newId(),
      host: host.trim(),
      shareName: shareName.trim(),
      account: account.trim() || 'share',
      password,
      mountPoint: initial?.mountPoint || '',
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
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isEdit ? '留空保持原密码' : '留空挂载时再填'} />
        </label>
      </div>
      <p className="hint">
        挂载点：{root ? `${root}/${shareName || '<共享名>'}` : `~/Shared/${shareName || '<共享名>'}`}
        {hostHasPassword && ' · 本机留空密码将使用该主机的统一密码'}
      </p>
      {err && <p className="error">{err}</p>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn primary" onClick={submit}>{isEdit ? '保存' : '添加'}</button>
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
