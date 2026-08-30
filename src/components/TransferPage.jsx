/* global setInterval, clearInterval */
import React, { useEffect, useState, useCallback } from 'react';

const fmtSize = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
};

const SEND_STATE = { queued: '排队中', waiting: '等待接收', sending: '传输中', done: '已完成', error: '失败' };

export default function TransferPage() {
  const [info, setInfo] = useState(null);
  const [ports, setPorts] = useState(null);
  const [devices, setDevices] = useState([]);
  const [file, setFile] = useState(null);
  const [target, setTarget] = useState('');
  const [sends, setSends] = useState([]);
  const [offers, setOffers] = useState([]);
  const [receiving, setReceiving] = useState({}); // transferId -> {state, targetDir}
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [section, setSection] = useState('send');
  const [transferPrefs, setTransferPrefs] = useState({ compressFolders: false, cacheDir: '' });

  const show = useCallback((text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); }, []);
  const pickFile = async (kind = 'file') => {
    try {
      const selected = await window.api.transfer.selectFile(kind);
      setFile(selected);
      if (selected) show(`已选择${selected.kind === 'folder' ? '文件夹' : '文件'}：${selected.name}`);
    } catch (e) { setError(String(e.message || e)); }
  };

  const refresh = useCallback(async () => {
    try {
      const [sd, of] = await Promise.all([
        window.api.transfer.sends().catch(() => []),
        window.api.transfer.listOffers().catch(() => []),
      ]);
      setSends(sd || []);
      setOffers(of || []);
      // 汇总接收中的会话状态（accepted/transferring/completed）
      const recv = {};
      for (const o of of || []) {
        const st = await window.api.transfer.status(o.transferId).catch(() => null);
        if (st?.server?.state && st.server.state !== 'offered') recv[o.transferId] = { state: st.server.state, targetDir: st.server.targetDir };
      }
      setReceiving(recv);
    } catch { /* 忽略轮询失败 */ }
  }, []);

  useEffect(() => {
    window.api.transfer.info().then(setInfo).catch(() => setError('无法读取 P2P 传输服务状态'));
    window.api.transfer.getSettings().then(setTransferPrefs).catch(() => {});
    window.api.services.ports().then(setPorts).catch(() => setPorts({ transfer: 49152, pairing: 7891 }));
    window.api.discovery.list().then((all) => setDevices((all || []).filter((d) => d.trust?.state === 'trusted' && d.presence?.online))).catch(() => setDevices([]));
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const send = async () => {
    if (!file) return show('请先选择要发送的文件或文件夹', false);
    if (!target) return show('请选择接收设备', false);
    const dev = devices.find((d) => d.deviceId === target);
    const transferPort = Number(ports?.transfer) || 49152;
    const pairingPort = Number(ports?.pairing) || 7891;
    try {
      const r = await window.api.transfer.offer({
        targetAddress: dev.network?.preferredAddress,
        targetPort: Number(dev.services?.transfer?.port) || transferPort,
        pairingPort: Number(dev.services?.pairing?.port) || pairingPort,
        targetDeviceId: dev.deviceId,
        file,
      });
      if (!r.ok) return show(r.error || `发起失败（${r.reasonCode}），请确认对端已开机且已配对`, false);
      show(`已向 ${dev.deviceName || dev.deviceId.slice(0, 8)} 发起传输：${r.name}`);
      setFile(null);
      setTarget('');
      refresh();
    } catch (e) { show(String(e.message || e), false); }
  };

  const decide = async (offer, accept) => {
    try {
      const r = await window.api.transfer.decide({ transferId: offer.transferId, accept });
      if (!r.ok && r.reasonCode !== 'CANCELLED') return show(r.error || `操作失败（${r.reasonCode}）`, false);
      show(accept ? `已接受 ${offer.senderName} 的传输` : `已拒绝 ${offer.senderName} 的传输`);
      refresh();
    } catch (e) { show(String(e.message || e), false); }
  };

  const removeSend = async (transferId) => {
    const result = await window.api.transfer.removeSend(transferId);
    if (!result.ok) return show(result.reasonCode === 'TRANSFER_ACTIVE' ? '传输进行中，暂不能删除' : '记录已不存在', false);
    setSends((all) => all.filter((item) => item.transferId !== transferId));
  };

  const saveTransferPrefs = async (patch) => {
    try {
      const result = await window.api.transfer.setSettings({ ...transferPrefs, ...patch });
      if (!result.ok) return show('传输设置保存失败', false);
      setTransferPrefs({ compressFolders: result.compressFolders, cacheDir: result.cacheDir });
      show(result.restartRequired ? '设置已保存，缓存目录将在重启应用后完全生效' : '传输设置已保存');
    } catch (e) { show(String(e.message || e), false); }
  };

  const chooseCacheDir = async () => {
    const selected = await window.api.transfer.selectCacheDir();
    if (selected) await saveTransferPrefs({ cacheDir: selected });
  };

  const tPort = Number(ports?.transfer) || 49152;

  const sendWorkspace = (
    <>
      <div className="transfer-workspace-head">
        <div><span className="transfer-kicker">发送文件</span><h2>选择要发送的内容</h2><p>文件将通过已配对设备之间的加密认证通道直接传输。</p></div>
        <span className={`transfer-service-dot ${info?.port ? 'online' : ''}`}>{info?.port ? '服务在线' : '服务未启动'}</span>
      </div>

      <div className="transfer-picker-grid">
        <button className="transfer-picker" onClick={() => pickFile('file')}><span>▤</span><strong>文件</strong><small>选择单个文件</small></button>
        <button className="transfer-picker" onClick={() => pickFile('folder')}><span>▰</span><strong>文件夹</strong><small>{transferPrefs.compressFolders ? '打包压缩为 ZIP' : '保持目录结构，不压缩'}</small></button>
      </div>

      {file ? (
        <div className="transfer-selection">
          <span className="transfer-file-icon">{file.kind === 'folder' ? '▰' : '▤'}</span>
          <div><strong>{file.name}</strong><span>{file.kind === 'folder' ? `文件夹 · ${transferPrefs.compressFolders ? '发送前压缩' : '不压缩传输'}` : fmtSize(file.size)}</span></div>
          <button className="btn small ghost" onClick={() => setFile(null)}>移除</button>
        </div>
      ) : <div className="transfer-empty-line">尚未选择内容</div>}

      <div className="transfer-device-section">
        <div className="transfer-section-title"><div><h3>可信设备</h3><p>仅显示在线且已配对的设备</p></div><span>{devices.length} 台可用</span></div>
        {devices.length ? (
          <div className="transfer-device-grid">
            {devices.map((d) => (
              <button key={d.deviceId} className={`transfer-device ${target === d.deviceId ? 'selected' : ''}`} onClick={() => setTarget(d.deviceId)}>
                <span className="transfer-device-avatar">{String(d.deviceName || '设').slice(0, 1).toUpperCase()}</span>
                <span><strong>{d.deviceName || d.deviceId.slice(0, 8)}</strong><small>{d.network?.preferredAddress || '地址未知'}</small></span>
                <i>{target === d.deviceId ? '✓' : '›'}</i>
              </button>
            ))}
          </div>
        ) : <div className="transfer-big-empty"><span>⌁</span><strong>没有可用设备</strong><p>请确认对端在线，并先在设备中心完成配对。</p></div>}
      </div>

      {(file || target) && <div className="transfer-sendbar"><span>{file && target ? `准备向 ${devices.find((d) => d.deviceId === target)?.deviceName || '所选设备'}发送「${file.name}」` : '请选择内容和接收设备'}</span><button className="btn primary" disabled={!file || !target} onClick={send}>发送</button></div>}

      {sends.length > 0 && <div className="transfer-history"><div className="transfer-section-title"><div><h3>最近发送</h3><p>默认展示最近 5 条传输记录</p></div></div>{sends.slice(0, 5).map((s) => <div className="transfer-task" key={s.transferId}><span className="transfer-file-icon">▤</span><div><strong>{s.name}</strong><span>{s.state === 'done' ? fmtSize(s.total) : `${fmtSize(s.sent)} / ${fmtSize(s.total)}`}{s.error ? ` · ${s.error}` : ''}</span><div className="transfer-progress"><i style={{ width: `${s.total ? Math.min(100, (s.sent / s.total) * 100) : 0}%` }} /></div></div><em className={s.state === 'error' ? 'error' : ''}>{SEND_STATE[s.state] || s.state}</em><button className="transfer-history-delete" disabled={!['done', 'error'].includes(s.state)} title={['done', 'error'].includes(s.state) ? '删除记录' : '传输完成后可删除'} onClick={() => removeSend(s.transferId)}>删除</button></div>)}</div>}
    </>
  );

  const receiveWorkspace = (
    <>
      <div className="transfer-workspace-head"><div><span className="transfer-kicker">接收文件</span><h2>等待附近设备发送</h2><p>每次传输都需要你确认，文件校验完成后才会写入所选目录。</p></div><span className="transfer-count-badge">{offers.length} 个请求</span></div>
      {offers.length === 0 ? <div className="transfer-big-empty fill"><span>⌁</span><strong>正在等待传输</strong><p>保持 InnerNet 运行，来自已配对设备的请求会出现在这里。</p></div> : <div className="transfer-offer-list">{offers.map((o) => <div key={o.transferId} className="transfer-offer-card"><span className="transfer-file-icon">{o.kind === 'folder' ? '▰' : '▤'}</span><div><strong>{o.name}</strong><span>来自 {o.senderName} · {o.kind === 'folder' ? '文件夹' : fmtSize(o.size)}</span></div>{receiving[o.transferId] ? <em>{receiving[o.transferId].state === 'completed' ? '接收完成' : '正在接收'}</em> : <div className="transfer-offer-actions"><button className="btn small danger" onClick={() => decide(o, false)}>拒绝</button><button className="btn small primary" onClick={() => decide(o, true)}>接受</button></div>}</div>)}</div>}
    </>
  );

  const settingsWorkspace = (
    <>
      <div className="transfer-workspace-head"><div><span className="transfer-kicker">传输设置</span><h2>本机传输服务</h2><p>查看监听状态、端口和临时缓存位置。</p></div></div>
      <div className="transfer-settings-grid">
        <div><span>传输服务</span><strong className={info?.port ? 'ok-text' : 'warn-text'}>{info?.port ? '运行正常' : '未启动'}</strong><small>接收来自可信设备的传输请求</small></div>
        <div><span>监听地址</span><strong className="mono">{info?.host || '0.0.0.0'}:{info?.port || tPort}</strong><small>Windows 防火墙需允许此 TCP 端口</small></div>
        <div><span>文件夹传输</span><strong>{transferPrefs.compressFolders ? '压缩为 ZIP' : '默认不压缩'}</strong><small>内网传输默认保持目录结构，减少压缩等待。</small><label className="transfer-toggle"><input type="checkbox" checked={transferPrefs.compressFolders} onChange={(e) => saveTransferPrefs({ compressFolders: e.target.checked })} />压缩文件夹</label></div>
        <div className="wide"><span>缓存目录</span><strong className="mono">{transferPrefs.cacheDir || info?.root || '—'}</strong><small>内容校验通过后才会移动到你选择的保存目录；修改目录后需重启应用。</small><button className="btn small" onClick={chooseCacheDir}>修改缓存目录</button></div>
      </div>
    </>
  );

  return (
    <section className="transfer-page">
      <aside className="transfer-sidebar">
        <div className="transfer-sidebar-brand"><div><strong>P2P 传输</strong><small>可信设备直连</small></div></div>
        <nav aria-label="P2P 传输功能">
          <button className={section === 'receive' ? 'active' : ''} onClick={() => setSection('receive')}><span>⌁</span>接收{offers.length > 0 && <i>{offers.length}</i>}</button>
          <button className={section === 'send' ? 'active' : ''} onClick={() => setSection('send')}><span>➤</span>发送</button>
          <button className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')}><span>⚙</span>设置</button>
        </nav>
        <div className="transfer-sidebar-status"><i className={info?.port ? 'online' : ''} /><span>{info?.port ? '本机可被发现' : '传输服务离线'}</span></div>
      </aside>
      <main className="transfer-workspace">
        {section === 'send' ? sendWorkspace : section === 'receive' ? receiveWorkspace : settingsWorkspace}
        {error && <p className="settings-hint warn-text">{error}</p>}
      </main>

      {msg && <div className={`toast ${msg.ok ? '' : 'err'}`}>{msg.text}</div>}
    </section>
  );
}
