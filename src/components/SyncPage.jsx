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

const ROLE_LABEL = { master: '主端', slave: '从端' };

function TaskStatusBadge({ task }) {
  const s = task.status || {};
  if (!s.started && !s.running) {
    return <span className="badge warn-text">已停止</span>;
  }
  if (s.peerStopped) return <span className="badge warn-text">对端已停止</span>;
  if (s.running) return (
    <span className="badge ok">同步中{s.currentFile ? `：${s.currentFile}` : ''}</span>
  );
  return (
    <span className="badge ok">
      运行中
      <span className="hint" style={{ marginLeft: 6 }}>
        {s.lastError ? `最近错误：${s.lastError}` : '监听中，等待变更或下一轮全量校验'}
      </span>
    </span>
  );
}

/** 新建/编辑任务表单（Modal 内，grid 对齐）。编辑时角色不可改（同步语义由角色决定）。 */
function TaskForm({ task, peers, onDone, onError }) {
  const editing = Boolean(task?.id);
  const invited = Boolean(task?.invitationId);
  const [form, setForm] = useState({
    name: task?.name || '',
    role: task?.role || 'master',
    localRoot: task?.localRoot || '',
    pairKey: task?.pairKey || '',
    peerDeviceId: task?.peerDeviceId || '',
    peerAddress: task?.peerAddress || '',
    peerPort: task?.peerPort || 7892,
    trashRetentionDays: task?.trashRetentionDays ?? 7,
    ignore: task?.ignore || '',
    cleanupIgnoredOnSlave: Boolean(task?.cleanupIgnoredOnSlave),
  });
  const [pickOpen, setPickOpen] = useState(false); // 忽略项选择器
  const [entries, setEntries] = useState([]);
  const [checked, setChecked] = useState({});
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const pickDir = async () => {
    const dir = await window.api.sync.pickDir();
    if (dir) set('localRoot', dir);
  };

  const pickPeerDevice = (deviceId) => {
    const d = peers.find((x) => x.deviceId === deviceId);
    set('peerDeviceId', deviceId);
    if (d?.network?.preferredAddress) set('peerAddress', d.network.preferredAddress);
  };

  const openIgnorePicker = async () => {
    const list = await window.api.sync.listDir(form.localRoot);
    setEntries(list);
    setChecked({});
    setPickOpen(true);
  };

  // 勾选生成规则：文件夹 → name/（仅目录），文件 → name；追加进 ignore 文本（去重）
  const applyIgnorePick = () => {
    const rules = Object.entries(checked)
      .filter(([, on]) => on)
      .map(([name]) => `${name}${entries.find((e) => e.name === name)?.isDir ? '/' : ''}`);
    if (!rules.length) { setPickOpen(false); return; }
    const existing = form.ignore.split('\n').map((s) => s.trim()).filter(Boolean);
    const merged = [...existing];
    for (const r of rules) if (!merged.includes(r)) merged.push(r);
    set('ignore', merged.join('\n'));
    setPickOpen(false);
  };

  const submit = async () => {
    if (!form.name.trim()) return onError('请填写任务名称');
    if (!form.localRoot) return onError('请选择本端目录');
    if (form.role === 'slave' && !form.pairKey.trim()) return onError('从端任务需要填写主端显示的「配对码」，用于两端关联同一条同步');
    if (!form.peerDeviceId || !form.peerAddress) return onError('请选择从端设备并确认地址');
    try {
      if (editing) {
        await window.api.sync.updateTask(task.id, form);
        onDone('任务已更新');
      } else {
        const created = await window.api.sync.addTask(form);
        const invite = created?.invitation;
        onDone(form.role === 'master' && invite
          ? invite.delivered
            ? '主端任务已创建，已通知从端填写保存目录'
            : `主端任务已创建，但邀请未送达：${invite.error || '对端同步服务不可用'}`
          : '任务已创建，点击「启动」开始同步');
      }
    } catch (e) {
      onError(String(e.message || e));
    }
  };

  return (
    <div className="task-form">
      {invited && (
        <div className="sync-invite-banner">
          <span>↘</span>
          <div>
            <strong>收到主端同步邀请</strong>
            <p>任务关联信息已自动填写，请只选择本机的从端目录，然后创建任务。</p>
          </div>
        </div>
      )}
      <span className="k">任务名称</span>
      <input className="text-input" value={form.name}
        onChange={(e) => set('name', e.target.value)} placeholder="如：项目代码同步到工作机" />

      <span className="k">角色</span>
      <div>
        <div className="seg">
          {['master', 'slave'].map((r) => (
            <button key={r} disabled={editing || invited} className={form.role === r ? 'on' : ''} onClick={() => set('role', r)}>
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 4 }}>
          {form.role === 'master' ? '主端：本端目录变更推送到从端' : '从端：接收主端推送'}
        </p>
      </div>

      <span className="k">{form.role === 'master' ? '主端目录' : '从端目录'}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="text-input" style={{ flex: 1 }} value={form.localRoot} readOnly placeholder="点击右侧按钮选择目录" />
        <button className="btn small" onClick={pickDir}>选择</button>
      </div>

      <span className="k">配对码</span>
      {form.role === 'slave' ? (
        <div>
          <input className="text-input" style={{ width: 140 }} value={form.pairKey}
            readOnly={invited}
            onChange={(e) => set('pairKey', e.target.value.toUpperCase().trim())}
            placeholder="如 AB3XY9" maxLength={6} />
          <p className="hint" style={{ marginTop: 4 }}>填主端任务卡片上显示的 6 位码，两端靠它关联同一条同步</p>
        </div>
      ) : (
        <p className="hint">
          <code className="mono" style={{ fontSize: 15, marginRight: 8 }}>{task?.pairKey || '创建后自动生成'}</code>
          对端新建从端任务时填这个码即可关联
        </p>
      )}

      <span className="k">{form.role === 'master' ? '从端设备' : '主端设备'}</span>
      <div>
        <select className="text-input" style={{ width: 260 }} value={form.peerDeviceId} disabled={invited} onChange={(e) => pickPeerDevice(e.target.value)}>
          <option value="">选择已配对设备…</option>
          {form.peerDeviceId && !peers.some((d) => d.deviceId === form.peerDeviceId) && (
            <option value={form.peerDeviceId}>{task?.peerDeviceName || form.peerDeviceId}</option>
          )}
          {peers.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.deviceName || d.name || d.deviceId}{d.network?.preferredAddress ? `（${d.network.preferredAddress}）` : ''}
            </option>
          ))}
        </select>
        {!peers.length && <p className="hint" style={{ marginTop: 4 }}>设备中心暂无已配对设备，请先完成配对</p>}
      </div>

      <span className="k">{form.role === 'master' ? '从端地址' : '主端地址'}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="text-input" style={{ width: 180 }} value={form.peerAddress}
          readOnly={invited}
          onChange={(e) => set('peerAddress', e.target.value.trim())} placeholder="如 192.168.5.50" />
        <span className="k" style={{ textAlign: 'left' }}>端口</span>
        <input className="text-input" type="number" style={{ width: 80 }} value={form.peerPort}
          readOnly={invited}
          onChange={(e) => set('peerPort', Number(e.target.value))} />
      </div>

      {form.role === 'master' && (
        <>
          <span className="k">回收保留</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="text-input" type="number" style={{ width: 80 }} value={form.trashRetentionDays}
              onChange={(e) => set('trashRetentionDays', Number(e.target.value))} />
            <span className="hint">天；主端删除的文件在从端先入回收区，超期自动清理</span>
          </div>

          <span className="k">忽略规则</span>
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <button className="btn small ghost" onClick={openIgnorePicker} disabled={!form.localRoot}
                title="从本端目录勾选要忽略的文件/文件夹，自动生成规则">从目录选择…</button>
              <span className="hint">勾选生成规则；也可手写，每行一条 gitignore 风格</span>
            </div>
            <textarea className="text-input" style={{ width: '100%', minHeight: 64, fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
              value={form.ignore} onChange={(e) => set('ignore', e.target.value)}
              placeholder={'node_modules\ndist\n*.log\ntmp/'} />
          </div>

          <span className="k">排除项处理</span>
          <div>
            <div className="seg">
              <button className={!form.cleanupIgnoredOnSlave ? 'on' : ''}
                onClick={() => set('cleanupIgnoredOnSlave', false)}>从端保留</button>
              <button className={form.cleanupIgnoredOnSlave ? 'on' : ''}
                onClick={() => set('cleanupIgnoredOnSlave', true)}>标记失效并清理</button>
            </div>
            <p className={`hint ${form.cleanupIgnoredOnSlave ? 'warn-text' : ''}`} style={{ marginTop: 6 }}>
              {form.cleanupIgnoredOnSlave
                ? '命中忽略规则且已存在于从端的内容，会在下次全量同步时移入从端回收区。'
                : '命中忽略规则的内容不再同步，但从端已有文件会保留不动。'}
            </p>
          </div>
        </>
      )}

      {pickOpen && (
        <div className="modal-mask" style={{ zIndex: 20 }} onClick={() => setPickOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>选择要忽略的内容</h3>
              <button className="icon-btn" onClick={() => setPickOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="hint" style={{ marginBottom: 8 }}>目录：{form.localRoot}</p>
              {entries.length === 0 ? (
                <p className="empty">目录为空或不可读</p>
              ) : (
                <div className="trash-list">
                  {entries.map((e) => (
                    <label key={e.name} className="trash-item" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={Boolean(checked[e.name])}
                        onChange={(ev) => setChecked((c) => ({ ...c, [e.name]: ev.target.checked }))} />
                      <code className="mono">{e.isDir ? `${e.name}/` : e.name}</code>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setPickOpen(false)}>取消</button>
              <button className="btn primary" onClick={applyIgnorePick}>加入忽略规则</button>
            </div>
          </div>
        </div>
      )}

      <div className="modal-foot" style={{ gridColumn: '1 / -1' }}>
        <button className="btn" onClick={onDone}>取消</button>
        <button className="btn primary" onClick={submit}>{editing ? '保存' : '创建任务'}</button>
      </div>
    </div>
  );
}

export default function SyncPage({ invitation = null, onInvitationHandled = () => {} }) {
  const [state, setState] = useState({ tasks: [] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [peers, setPeers] = useState([]);
  const [formTask, setFormTask] = useState(null); // null | {} 新建 | task 编辑
  const [trashTask, setTrashTask] = useState(null); // 查看回收区的任务
  const [trash, setTrash] = useState([]);
  const [confirmReset, setConfirmReset] = useState(null); // 待确认清空索引的任务

  const show = useCallback((text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setState(await window.api.sync.state());
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

  useEffect(() => {
    let alive = true;
    window.api.discovery?.list?.()
      .then((all) => { if (alive) setPeers((all || []).filter((d) => d.trust?.state === 'trusted')); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!invitation) return;
    setFormTask({
      invitationId: invitation.invitationId,
      name: invitation.taskName || '同步任务',
      role: 'slave',
      localRoot: '',
      pairKey: invitation.pairKey || '',
      peerDeviceId: invitation.peerDeviceId || '',
      peerDeviceName: invitation.peerDeviceName || '',
      peerAddress: invitation.peerAddress || '',
      peerPort: Number(invitation.peerPort) || 7892,
    });
    onInvitationHandled();
  }, [invitation, onInvitationHandled]);

  const guard = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) show(okMsg);
      refresh();
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const start = (t) => guard(() => window.api.sync.start(t.id), `「${t.name}」已启动`);
  const stop = (t) => guard(() => window.api.sync.stop(t.id), `「${t.name}」已停止${t.role === 'master' ? '，对端将收到通知' : ''}`);
  const runNow = (t) => guard(() => window.api.sync.runNow(t.id));
  const removeTask = (t) => guard(() => window.api.sync.removeTask(t.id), `「${t.name}」已删除`);
  const resetIndex = (t) => guard(() => window.api.sync.resetIndex(t.id), '已清空索引，下次同步将全量比对');
  const invitePeer = (t) => guard(async () => {
    const result = await window.api.sync.invite(t.id);
    if (!result?.ok) throw new Error(result?.error || '邀请未送达，请确认从端在线且同步服务可访问');
  }, `已向从端重新发送「${t.name}」同步邀请`);

  const openTrash = async (t) => {
    try {
      setTrash(await window.api.sync.trash(t.id));
      setTrashTask(t);
    } catch (e) {
      show(String(e.message || e), false);
    }
  };

  const restore = async (stamp, rel) => {
    try {
      await window.api.sync.restore(trashTask.id, { stamp, path: rel });
      show(`已恢复 ${rel}`);
      setTrash(await window.api.sync.trash(trashTask.id));
    } catch (e) {
      show(String(e.message || e), false);
    }
  };

  const purgeAll = async () => {
    try {
      const r = await window.api.sync.purgeTrash(trashTask.id, { all: true });
      show(`已清理 ${r.purged.length} 个回收批次`);
      setTrash(await window.api.sync.trash(trashTask.id));
    } catch (e) {
      show(String(e.message || e), false);
    }
  };

  const tasks = state.tasks || [];

  return (
    <div className="page app-page-surface">
      <div className="page-head">
        <div>
          <h2>文件同步</h2>
          <p className="sub">一次配置 = 一条同步任务；支持多条任务并存，运行中的任务不可修改配置</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={() => setFormTask({})}>新建同步任务</button>
        </div>
      </div>

      {tasks.length === 0 && (
        <div className="settings">
          <p className="hint" style={{ padding: 12 }}>
            还没有同步任务。点右上角「新建同步任务」创建第一条：选好角色、目录和对端设备后启动即可。
          </p>
        </div>
      )}

      {tasks.map((t) => {
        const s = t.status || {};
        const running = Boolean(s.started || s.running);
        return (
          <div key={t.id} className="settings" style={{ marginBottom: 14 }}>
            <div className="setting-row">
              <strong style={{ fontSize: 15 }}>{t.name || '未命名任务'}</strong>
              <span className="badge">{ROLE_LABEL[t.role]}</span>
              <TaskStatusBadge task={t} />
              {running && t.role === 'master' && <span className="btn ghost" style={{ cursor: 'default' }} title="停止后才能修改配置">🔒 配置已锁定</span>}
              <span style={{ flex: 1 }} />
            </div>
            <div className="setting-row">
              <span className="k">{t.role === 'master' ? '主端目录' : '从端目录'}</span>
              <code className="mono" style={{ flex: 1, wordBreak: 'break-all' }}>{t.localRoot || '未配置'}</code>
            </div>
            <div className="setting-row">
              <span className="k">对端</span>
              <span className="mono">{t.peerAddress || '未配置'}:{t.peerPort}</span>
              <span className="k" style={{ marginLeft: 16 }}>忽略规则</span>
              <span className="hint">{t.ignore ? `${t.ignore.split('\n').filter(Boolean).length} 条` : '无'}</span>
              {t.role === 'master' && t.ignore && (
                <span className={`hint ${t.cleanupIgnoredOnSlave ? 'warn-text' : ''}`}>
                  · {t.cleanupIgnoredOnSlave ? '从端失效后回收' : '从端保留'}
                </span>
              )}
              {Number(s.pendingRetry) > 0 && (
                <span className="hint warn-text" style={{ marginLeft: 12 }}>待补偿 {s.pendingRetry} 个文件（下轮自动重推）</span>
              )}
            </div>
            <div className="setting-row" style={{ borderTop: '1px dashed var(--border)', paddingTop: 12, marginTop: 4 }}>
              <span className="k">操作</span>
              {t.role === 'master' && <button className="btn" onClick={() => invitePeer(t)} disabled={busy}>邀请从端</button>}
              {running ? (
                <>
                  {t.role === 'master' && (
                    <>
                      <button className="btn primary" onClick={() => runNow(t)} disabled={busy}
                        title="手动触发一轮全量同步">立即同步</button>
                      <button className="btn ghost" onClick={() => setConfirmReset(t)} disabled={busy}
                        title="清空该任务的同步索引；下次同步将全量比对推送所有文件">清空索引</button>
                    </>
                  )}
                  {t.role === 'slave' && (
                    <button className="btn" onClick={() => openTrash(t)} disabled={busy}>回收区</button>
                  )}
                  <button className="btn danger" onClick={() => stop(t)} disabled={busy}>停止</button>
                  <span className="hint" style={{ cursor: 'default' }} title="运行中的任务不可修改配置或删除，请先停止">编辑 / 删除需先停止</span>
                </>
              ) : (
                <>
                  <button className="btn primary" onClick={() => start(t)} disabled={busy}>启动</button>
                  <button className="btn" onClick={() => setFormTask(t)} disabled={busy}>编辑</button>
                  {t.role === 'slave' && <button className="btn" onClick={() => openTrash(t)} disabled={busy}>回收区</button>}
                  <button className="btn danger" onClick={() => removeTask(t)} disabled={busy}>删除</button>
                </>
              )}
            </div>
            {s.lastError && !running && <p className="hint warn-text" style={{ padding: '0 12px' }}>最近错误：{s.lastError}</p>}
            {(t.pairKey || (t.history || []).length > 0) && (
              <div className="setting-row" style={{ borderTop: '1px dashed var(--border)', paddingTop: 8, marginTop: 6 }}>
                {t.role === 'master' && t.pairKey && (
                  <>
                    <span className="k">配对码</span>
                    <code className="mono" style={{ fontSize: 14 }}>{t.pairKey}</code>
                    <button className="btn small ghost" onClick={() => { navigator.clipboard?.writeText(t.pairKey); show('配对码已复制'); }}
                      title="复制配对码，对端创建从端任务时填写">复制</button>
                    <span className="hint">对端「从端任务」填此码关联</span>
                  </>
                )}
                {(t.history || []).slice(0, 3).map((h, i) => (
                  <span key={i} className={`hint ${h.kind === 'notify' ? 'warn-text' : ''}`} style={{ marginLeft: 12 }} title={new Date(h.at).toLocaleString()}>
                    {h.kind === 'notify' ? '🔔' : h.ok ? '✓' : '✗'} {h.message || h.path}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {formTask && (
        <Modal title={formTask.id ? '编辑同步任务' : formTask.invitationId ? '接受主端同步邀请' : '新建同步任务'} onClose={() => setFormTask(null)}>
          <TaskForm
            task={formTask}
            peers={peers}
            onDone={(m) => { setFormTask(null); if (m) show(m); refresh(); }}
            onError={(m) => show(m, false)}
          />
        </Modal>
      )}

      {trashTask && (
        <Modal title={`回收区 — ${trashTask.name}`} onClose={() => setTrashTask(null)}>
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

      {confirmReset && (
        <Modal title={`确认清空索引 — ${confirmReset.name}`} onClose={() => setConfirmReset(null)}>
          <p>清空索引会删除该任务对主端目录<strong>已同步文件的记录</strong>（文件大小 + 修改时间快照）。</p>
          <p>之后下一轮同步将<strong>忘记之前同步过什么</strong>，改为<strong>全量重新比对并推送所有文件</strong>给从端。</p>
          <ul className="reset-warn">
            <li>不会删除任何真实文件，也不动从端现有文件；</li>
            <li>主端已删除的文件，因记忆被清空，将<strong>不再触发从端回收</strong>；</li>
            <li>大目录全量重推较慢，<strong>日常同步无需此操作</strong>，仅用于索引异常或强制全量重推。</li>
          </ul>
          <div className="modal-foot">
            <button className="btn" onClick={() => setConfirmReset(null)}>取消</button>
            <button className="btn danger" onClick={() => { const t = confirmReset; setConfirmReset(null); resetIndex(t); }}>确认清空</button>
          </div>
        </Modal>
      )}

      {msg && <div className={`toast ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}
