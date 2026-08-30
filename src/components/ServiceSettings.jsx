import React, { useEffect, useState } from 'react';

const SERVICES = [
  { key: 'discovery', label: '设备发现', proto: 'UDP', port: 49321, desc: '局域网内发现运行 InnerNet 的设备（只广播自身，不主动扫描）' },
  { key: 'chat', label: '群聊 / 共享清单', proto: 'TCP', port: 7890, desc: '群聊服务与共享清单接口（Windows 端提供）' },
  { key: 'pairing', label: '安全配对', proto: 'TCP', port: 7891, desc: '设备配对与解除配对消息' },
  { key: 'sync', label: '文件同步', proto: 'TCP', port: 7892, desc: '主从文件同步（从端任务监听此端口）' },
  { key: 'transfer', label: '原生传输', proto: 'TCP', port: 49152, desc: 'P2P 文件传输，端口被占用时自动回退' },
];

const find = (key) => SERVICES.find((s) => s.key === key) || { label: key };

export default function ServiceSettings() {
  const [ports, setPorts] = useState(null);
  const [health, setHealth] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const scan = () => window.api.services?.health?.().then(setHealth).catch(() => setMessage('健康检查失败，请重试。'));

  useEffect(() => {
    const defaults = Object.fromEntries(SERVICES.map((s) => [s.key, s.port]));
    const load = window.api.services?.ports?.();
    if (!load) {
      setPorts(defaults);
      setMessage('当前运行版本未提供端口配置 IPC，已显示默认端口；请重启开发服务。');
    } else {
      load.then(setPorts).catch(() => { setPorts(defaults); setMessage('端口配置读取失败，已显示默认端口。'); });
    }
    scan();
  }, []);

  const save = async () => {
    if (!window.api.services?.setPorts) { setMessage('当前运行版本不支持保存端口配置，请重启开发服务。'); return; }
    setBusy(true);
    const result = await window.api.services.setPorts(ports);
    setBusy(false);
    setMessage(result.ok ? '端口配置已保存，请重启应用后生效。' : '端口配置保存失败。');
    scan();
  };

  if (!ports) return <section className="settings app-page-surface"><p>正在读取服务配置…</p></section>;

  const healthByName = Object.fromEntries((health?.services || []).map((item) => [item.name, item]));
  const healthyCount = (health?.services || []).filter((item) => item.state === 'healthy').length;
  const occupiedCount = (health?.services || []).filter((item) => item.state === 'occupied').length;

  return (
    <section className="service-settings app-page-surface">
      <div className="service-settings-hero">
        <div>
          <h2>服务设置</h2>
          <p>管理 InnerNet 的设备发现、安全配对、群聊、同步和点对点传输端口。</p>
        </div>
        <button className="btn" onClick={scan}>重新检测</button>
      </div>

      <div className="service-overview">
        <div><span className="service-overview-icon ok">✓</span><span><strong>{healthyCount}</strong><small>运行中的服务</small></span></div>
        <div><span className={`service-overview-icon ${occupiedCount ? 'warn' : ''}`}>!</span><span><strong>{occupiedCount}</strong><small>需要处理的端口</small></span></div>
        <div><span className="service-overview-icon">⌁</span><span><strong>仅本机</strong><small>检测不扫描局域网</small></span></div>
      </div>

      <div className="service-section-head"><div><h3>功能服务</h3><p>端口需要与对端配置一致；修改后重启应用生效。</p></div></div>
      <div className="service-card-grid">
        {SERVICES.map((meta) => {
          const item = healthByName[meta.key];
          const stateLabel = item?.state === 'healthy' ? '运行正常' : item?.state === 'occupied' ? '端口冲突' : item ? '未运行' : '等待检测';
          return (
            <article className={`service-card ${item?.state || ''}`} key={meta.key}>
              <div className="service-card-head">
                <span className="service-card-icon">{meta.key === 'discovery' ? '⌁' : meta.key === 'chat' ? '◌' : meta.key === 'pairing' ? '◇' : meta.key === 'sync' ? '↕' : '⇄'}</span>
                <div><strong>{meta.label}</strong><span>{meta.proto} 服务</span></div>
                <em><i />{stateLabel}</em>
              </div>
              <p>{meta.desc}</p>
              <label className="service-port-input"><span>监听端口</span><div><small>:</small><input aria-label={`${meta.label}端口`} type="number" min="1" max="65535" value={ports[meta.key] ?? meta.port} onChange={(e) => setPorts({ ...ports, [meta.key]: e.target.value })} /></div></label>
              {item?.state === 'occupied' && item.suggestedPort && <button className="service-suggestion" onClick={() => setPorts({ ...ports, [meta.key]: item.suggestedPort })}>端口已被其他程序占用，改用建议端口 {item.suggestedPort}</button>}
            </article>
          );
        })}
      </div>

      <div className="service-settings-footer">
        <div><strong>应用新的端口配置</strong><span>保存不会中断当前服务，重启 InnerNet 后统一生效。</span>{message && <em>{message}</em>}</div>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存配置'}</button>
      </div>
    </section>
  );
}
