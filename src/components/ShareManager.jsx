import React, { useCallback, useEffect, useState } from 'react';

/** 简易 toast */
function useToast() {
  const [msg, setMsg] = useState(null);
  const show = useCallback((text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  }, []);
  return { msg, show };
}

/** 复制文本，带 execCommand 降级（clipboard API 不可用时） */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-mask">
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

function AddShareForm({ sys, onDone, onCancel }) {
  const [dirPath, setDirPath] = useState('');
  const [shareName, setShareName] = useState('');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [unified] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { setAccount('shareuser'); setPassword(''); }, [sys]);

  const pickDir = async () => {
    const p = await window.api.selectFolder();
    if (!p) return;
    setDirPath(p);
    if (!shareName) {
      const name = p.replace(/[\\/]$/, '').split(/[\\/]/).pop() || 'share';
      setShareName(name.replace(/[*?\/\\|:<>"]/g, '_'));
    }
  };

  const submit = async () => {
    setErr('');
    if (!dirPath) return setErr('请选择文件夹');
    if (!shareName) return setErr('请填写共享名');
    if (unified && !password.trim()) return setErr('统一账号模式需要填写当前 Windows 登录密码');
    setBusy(true);
    try {
      await window.api.shares.add({
        dirPath,
        shareName,
        account: (account || 'shareuser').trim(),
        password: password || undefined,
        unified,
      });
      // 记住本次选择的模式，下次打开保持一致
      window.api.shares.setSettings({ unified });
      onDone();
    } catch (e) {
      const msg = String(e.message || e);
      // 按主进程显式给的 code 精确判断（NEED_ADMIN 由 share:add 入口的 isAdmin 守卫抛出）；
      // 不再匹配错误文本，避免把 icacls/net share 的"拒绝访问"误判成"非管理员"。
      const code = (e && e.code) || '';
      if (code === 'NEED_ADMIN' || /NEED_ADMIN/.test(msg)) {
        setErr('创建共享需要管理员权限：请退出程序，右键「以管理员身份运行」后再试。');
      } else {
        setErr(msg);
      }
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <label>
        共享文件夹
        <div className="row">
          <input value={dirPath} placeholder="点击右侧按钮选择文件夹" readOnly />
          <button className="btn" onClick={pickDir} type="button">选择…</button>
        </div>
      </label>
      <label>
        共享名
        <input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder="例如: 设计资料" />
      </label>
      {unified ? (
        <label>
          账号（专用本地账号）
          <input value={account || 'shareuser'} onChange={(e) => setAccount(e.target.value)} placeholder="shareuser" />
        </label>
      ) : (
        <label>
          账号
          <input value={account} onChange={(e) => setAccount(e.target.value)} />
        </label>
      )}
      <div className="grid2">
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={unified ? '当前 Windows 登录密码（必填）' : '留空自动生成'}
          />
        </label>
      </div>
      <p className="hint">
        {unified
          ? '请填写已存在的本地 Windows 用户名和密码。Microsoft 联机账号可能无法通过 SMB 网络认证。'
          : '账号密码留空则自动生成。已存在的账号会直接复用并授权。'}
      </p>
      {err && <p className="error">{err}</p>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? '创建中…' : '创建共享'}
        </button>
      </div>
    </div>
  );
}

export default function ShareManager({ sys }) {
  const [shares, setShares] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [copyId, setCopyId] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  // 默认遮罩，点了眼睛后单独显示
  const [revealedShares, setRevealedShares] = useState({});
  const [resetInput, setResetInput] = useState('');
  // 统一账号模式：密码同步 / 存量迁移 / 重置引导
  const [guideTarget, setGuideTarget] = useState(null);
  const [syncTarget, setSyncTarget] = useState(false);
  const [syncInput, setSyncInput] = useState('');
  const [migrateTarget, setMigrateTarget] = useState(false);
  const [migrateInput, setMigrateInput] = useState('');
  const { msg, show } = useToast();
  const globalBusy = busyId === 'sync' || busyId === 'migrate';

  const refresh = useCallback(async () => {
    const list = await window.api.shares.list();
    setShares(list);
  }, []);

  useEffect(() => {
    refresh().catch((e) => show(String(e.message || e), false));
  }, [refresh, show]);

  const remove = (s) => setConfirmTarget(s);

  const doRemove = async () => {
    const s = confirmTarget;
    if (!s) return;
    setBusyId(s.id);
    try {
      const list = await window.api.shares.remove(s.id);
      setShares(list);
      show(`已删除共享 ${s.shareName}`);
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusyId(null);
      setConfirmTarget(null);
    }
  };

  const resetPwd = (s) => {
    setResetInput('');
    setResetTarget(s);
  };

  const doReset = async () => {
    const s = resetTarget;
    if (!s) return;
    setBusyId(s.id);
    try {
      const updated = await window.api.shares.resetPassword({ id: s.id, password: resetInput });
      setShares((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      show('密码已重置');
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusyId(null);
      setResetTarget(null);
    }
  };

  // A2：把新登录密码同步到所有统一账号共享的记录
  const doSync = async () => {
    if (!syncInput.trim()) return show('请输入新的登录密码', false);
    setBusyId('sync');
    try {
      const r = await window.api.shares.syncUnifiedPassword({ password: syncInput });
      setShares(r.shares);
      show(`已同步 ${r.updated} 个统一账号共享的密码`);
      setSyncTarget(false);
      setSyncInput('');
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusyId(null);
    }
  };

  // A3：把存量非统一共享迁移到当前 Windows 登录账号
  const doMigrate = async () => {
    if (!migrateInput.trim()) return show('请输入当前 Windows 登录密码', false);
    setBusyId('migrate');
    try {
      const r = await window.api.shares.migrateToUnified({ password: migrateInput });
      setShares(r.shares);
      const ok = r.results.filter((x) => x.status === 'ok').length;
      const skipped = r.results.filter((x) => x.status === 'skip').length;
      const errs = r.results.filter((x) => x.status === 'error');
      let text = `迁移完成：成功 ${ok} 个`;
      if (skipped) text += `，跳过已统一 ${skipped} 个`;
      if (errs.length) text += `，${errs.length} 个失败`;
      show(text, errs.length === 0);
      if (errs.length) console.warn('[migrate] 部分失败:', errs);
      setMigrateTarget(false);
      setMigrateInput('');
    } catch (e) {
      show(String(e.message || e), false);
    } finally {
      setBusyId(null);
    }
  };

  const copyConn = async (s) => {
    // 与“导出清单”完全相同的数组 JSON 格式，Mac 端可直接粘贴导入。
    const text = JSON.stringify([
      { shareName: s.shareName, account: s.account, password: s.password },
    ], null, 2);
    const ok = await copyText(text);
    if (ok) {
      setCopyId(s.id);
      show('JSON 连接清单已复制，可在 Mac 端直接导入');
      setTimeout(() => setCopyId(null), 2000);
    } else {
      show('复制失败', false);
    }
  };

  const exportAll = async () => {
    if (!shares.length) return show('暂无共享', false);
    const text = JSON.stringify(
      shares.map((s) => ({ shareName: s.shareName, account: s.account, password: s.password })),
      null,
      2
    );
    const ok = await copyText(text);
    if (ok) show('全部共享清单已复制为 JSON，可在 Mac 端一键导入');
    else show('复制失败', false);
  };

  return (
    <div className="page app-page-surface">
      <div className="page-head">
        <div>
          <h2>共享文件夹</h2>
          <p className="sub">选择任意文件夹创建 SMB 共享，Mac 端聚合挂载访问</p>
        </div>
        <div className="head-actions">
          {shares.some((x) => x.unified) && (
            <button className="btn ghost" onClick={() => setSyncTarget(true)} disabled={globalBusy}>
              同步统一账号密码
            </button>
          )}
          {shares.some((x) => !x.unified) && (
            <button className="btn ghost" onClick={() => setMigrateTarget(true)} disabled={globalBusy}>
              迁移到统一账号
            </button>
          )}
          {shares.length > 0 && (
            <button className="btn ghost" onClick={exportAll} disabled={globalBusy}>导出清单</button>
          )}
          <button className="btn primary" onClick={() => setShowAdd(true)} disabled={globalBusy}>＋ 新建共享</button>
        </div>
      </div>

      {shares.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📁</div>
          <p>还没有共享</p>
          <p className="sub">点击右上角「新建共享」，选择任意文件夹即可开始</p>
        </div>
      ) : (
        <div className="share-list">
          {shares.map((s) => (
            <div className="share-card" key={s.id}>
              <div className="card-top">
                <div className="card-name">
                  <span className="dir-icon">📂</span>
                  <div>
                    <h3>{s.shareName}</h3>
                    <p className="path">{s.dirPath}</p>
                  </div>
                </div>
                <span className="badge ok">已共享</span>
              </div>
              <div className="creds">
                <div className="creds-row">
                  <span className="k">账号</span>
                  <span className="v">{s.account}</span>
                  <span className="k">密码</span>
                  <span className="v mono">{revealedShares[s.id] ? s.password : '••••••••'}</span>
                  <button
                    className="icon-btn"
                    title={revealedShares[s.id] ? '隐藏密码' : '显示密码'}
                    onClick={() => setRevealedShares((r) => ({ ...r, [s.id]: !r[s.id] }))}
                  >
                    {revealedShares[s.id] ? '🙈' : '👁'}
                  </button>
                </div>
                <div className="creds-row">
                  <span className="k">地址</span>
                  <span className="v mono">smb://{s.account}@&lt;本机IP&gt;/{s.shareName}</span>
                </div>
              </div>
              <div className="card-actions">
                <button className="btn small" onClick={() => copyConn(s)} disabled={busyId === s.id || globalBusy}>
                  {copyId === s.id ? '已复制 ✓' : '复制连接信息（含密码）'}
                </button>
                <button
                  className="btn small"
                  onClick={() => (s.unified ? setGuideTarget(s) : resetPwd(s))}
                  disabled={busyId === s.id || globalBusy}
                  title={s.unified ? '统一账号模式请通过 Windows 修改登录密码' : ''}
                >
                  重置密码
                </button>
                <button className="btn small danger" onClick={() => remove(s)} disabled={busyId === s.id || globalBusy}>
                  {busyId === s.id ? '处理中…' : '删除共享'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <Modal title="新建共享" onClose={() => setShowAdd(false)}>
          <AddShareForm
            sys={sys}
            onDone={() => {
              setShowAdd(false);
              refresh();
              show('共享创建成功');
            }}
            onCancel={() => setShowAdd(false)}
          />
        </Modal>
      )}

      {confirmTarget && (
        <Modal title="删除共享" onClose={() => setConfirmTarget(null)}>
          <p>确定删除共享「{confirmTarget.shareName}」吗？</p>
          <p className="hint">
            只删除共享关系，不会删除文件夹和文件。
            {confirmTarget.autoAccount ? `（自动生成的账号 ${confirmTarget.account} 会一并删除）` : ''}
            {confirmTarget.unified ? '（统一账号不会被删除）' : ''}
          </p>
          <div className="modal-foot">
            <button className="btn ghost" onClick={() => setConfirmTarget(null)}>取消</button>
            <button className="btn danger" onClick={doRemove} disabled={busyId === confirmTarget.id}>
              删除
            </button>
          </div>
        </Modal>
      )}

      {resetTarget && (
        <Modal title="重置密码" onClose={() => setResetTarget(null)}>
          <label>
            新密码（留空自动生成）
            <input
              value={resetInput}
              onChange={(e) => setResetInput(e.target.value)}
              placeholder="留空则自动生成"
            />
          </label>
          <div className="modal-foot">
            <button className="btn ghost" onClick={() => setResetTarget(null)}>取消</button>
            <button className="btn primary" onClick={doReset} disabled={busyId === resetTarget.id}>
              确定
            </button>
          </div>
        </Modal>
      )}

      {guideTarget && (
        <Modal title="统一账号模式 · 如何修改密码" onClose={() => setGuideTarget(null)}>
          <p>
            统一账号模式使用的是你当前的 Windows 登录账号（<b>{guideTarget.account}</b>），
            不能在软件内直接重置——那会修改你的系统登录密码。
          </p>
          <ol className="guide-steps">
            <li>在 Windows 中修改登录密码：设置 → 账户 → 登录选项 → 密码 → 更改。</li>
            <li>修改完成后，点上方「同步统一账号密码」，把新密码更新到本工具记录（用于 Mac 端挂载与连接信息导出）。</li>
          </ol>
          <p className="hint">
            提示：Windows 登录密码修改后，SMB 共享会自动使用新密码，无需重建共享；本工具仅保存一份副本供展示与导出。
          </p>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => setGuideTarget(null)}>知道了</button>
          </div>
        </Modal>
      )}

      {syncTarget && (
        <Modal title="同步统一账号密码" onClose={() => setSyncTarget(false)}>
          <p>请输入你当前的 Windows 登录密码，将更新到所有「统一账号模式」共享的记录中（用于 Mac 挂载与连接信息导出）。</p>
          <label>
            新密码
            <input
              type="password"
              value={syncInput}
              onChange={(e) => setSyncInput(e.target.value)}
              placeholder="当前 Windows 登录密码"
            />
          </label>
          <div className="modal-foot">
            <button className="btn ghost" onClick={() => setSyncTarget(false)}>取消</button>
            <button className="btn primary" onClick={doSync} disabled={busyId === 'sync'}>同步</button>
          </div>
        </Modal>
      )}

      {migrateTarget && (
        <Modal title="迁移到统一账号" onClose={() => setMigrateTarget(false)}>
          <p>
            将把所有「非统一账号」共享转换为使用当前 Windows 登录账号（<b>{sys.username || '?'}</b>），
            并删除其自动生成的专属账号、以登录账号重建共享。
          </p>
          <p className="hint warn-text">
            此操作会重建共享并删除旧账号，建议在确认无他人正在使用旧账号时执行。
          </p>
          <label>
            当前 Windows 登录密码
            <input
              type="password"
              value={migrateInput}
              onChange={(e) => setMigrateInput(e.target.value)}
              placeholder="用于统一账号"
            />
          </label>
          <div className="modal-foot">
            <button className="btn ghost" onClick={() => setMigrateTarget(false)}>取消</button>
            <button className="btn danger" onClick={doMigrate} disabled={busyId === 'migrate'}>开始迁移</button>
          </div>
        </Modal>
      )}

      {msg && <div className={`toast ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </div>
  );
}
