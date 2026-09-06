/* global setInterval, clearInterval */
import React, { useEffect, useState } from 'react';

const CAPABILITY_META = {
  chat: '群聊',
  fileSend: '发送文件',
  fileReceive: '接收文件',
  smbShare: 'SMB 共享',
  smbMount: 'SMB 挂载',
  shareSync: '文件同步',
  wolSender: '远程唤醒',
  wolTarget: '可被唤醒',
};
const capabilityStatus = (capability) => {
  if (capability.available) return '可用';
  if (capability.reasonCode === 'NOT_TRUSTED') return '需配对';
  if (capability.reasonCode === 'NOT_CONFIGURED') return '待配置';
  return '未就绪';
};

/** revokedName 非空表示这台设备刚刚解除了对本机的信任，需要重新配对 */
const statusText = (d, local = false, revokedName = '') => {
  if (local) return '在线 · 本机';
  if (d.trust?.state === 'identity_changed') return '设备身份已变化';
  if (revokedName) return '已被对方解除信任';
  if (!d.presence?.online) return '离线';
  return d.trust?.state === 'trusted' ? '在线 · 已信任' : '在线 · 待配对';
};

export default function DeviceCenter() {
  const [devices, setDevices] = useState([]);
  const [localDeviceId, setLocalDeviceId] = useState('');
  const [pairing, setPairing] = useState(null);
  const [incoming, setIncoming] = useState([]);
  const [notice, setNotice] = useState('');
  const [revokedBy, setRevokedBy] = useState({});
  const [accessLog, setAccessLog] = useState([]);
  const [wolTargets, setWolTargets] = useState({});
  const [localNics, setLocalNics] = useState([]);
  const [wolEditing, setWolEditing] = useState(null);
  const [wolDraft, setWolDraft] = useState({ targetMac: '', broadcast: '' });
  const [waking, setWaking] = useState('');

  const refresh = () => {
    Promise.all([window.api.device?.info?.(), window.api.discovery?.list?.()])
      .then(([local, all]) => {
        if (local?.deviceId) {
          setLocalDeviceId(local.deviceId);
          setDevices([
            { ...local, presence: { ...(local.presence || {}), online: true }, network: { ...(local.network || {}), preferredAddress: '本机' }, trust: { ...(local.trust || {}), state: 'local' } },
            ...(all || []).filter((d) => d.deviceId !== local.deviceId),
          ]);
        } else {
          setDevices(all || []);
        }
      })
      .catch(() => {});
    window.api.pairing?.pending?.().then(setIncoming).catch(() => {});
    window.api.access?.list?.().then(setAccessLog).catch(() => {});
    window.api.wol?.list?.().then(setWolTargets).catch(() => {});
  };

  useEffect(() => {
    window.api.wol?.localNics?.().then(setLocalNics).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    const offIncoming = window.api.pairing?.onIncoming?.((item) =>
      setIncoming((all) => (all.some((x) => x.sessionId === item.sessionId) ? all : [...all, item]))
    );
    // 对端主动解除信任时由主进程推送，这里立即刷新并给出明确原因
    const offRevoked = window.api.pairing?.onRevoked?.(({ deviceId, deviceName }) => {
      setRevokedBy((old) => ({ ...old, [deviceId]: deviceName || deviceId }));
      setNotice(`「${deviceName || deviceId}」已解除与本机信任，如需继续使用请重新配对。`);
      refresh();
    });
    return () => {
      clearInterval(timer);
      offIncoming?.();
      offRevoked?.();
    };
  }, []);

  const requestPairing = async (device) => {
    const result = await window.api.pairing.request(device);
    if (result.ok) {
      setPairing({ ...result, deviceName: device.deviceName, remoteDeviceId: device.deviceId, state: 'pending' });
      setNotice('配对请求已送达对端，请核对两台设备显示的 6 位验证码。');
    } else {
      setNotice(
        result.reasonCode === 'REMOTE_UNREACHABLE'
          ? '目标设备暂时无法连接，请确认它已开机且配对服务可访问。'
          : '无法发起配对，请检查目标设备信息后重试。'
      );
    }
  };

  useEffect(() => {
    if (!pairing?.sessionId || pairing.state !== 'pending') return undefined;
    const poll = async () => {
      const result = await window.api.pairing.status(pairing);
      if (result.ok && result.state !== 'pending') {
        setPairing((old) => ({ ...old, state: result.state }));
        setRevokedBy((old) => {
          const next = { ...old };
          delete next[pairing.remoteDeviceId];
          return next;
        });
        setNotice(result.state === 'accepted' ? '对端已确认验证码，配对完成。' : '配对未完成，请重新发起。');
        refresh();
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [pairing?.sessionId, pairing?.state, pairing?.host, pairing?.port, pairing?.remoteDeviceId]);

  const confirmIncoming = async (item) => {
    const result = await window.api.pairing.confirmIncoming({ sessionId: item.sessionId, code: item.code || '' });
    if (result.ok) {
      setIncoming((all) => all.filter((x) => x.sessionId !== item.sessionId));
      setRevokedBy((old) => {
        const next = { ...old };
        delete next[item.fromDeviceId];
        return next;
      });
      setNotice(`已确认 ${item.fromDeviceName} 的配对请求。`);
      refresh();
    } else {
      setNotice(`验证码未通过：${result.reasonCode || 'UNKNOWN'}`);
    }
  };

  const unpair = async (device) => {
    const result = await window.api.pairing.unpair(device);
    setRevokedBy((old) => {
      const next = { ...old };
      delete next[device.deviceId];
      return next;
    });
    setNotice(
      result?.delivered === false
        ? `已解除与 ${device.deviceName} 的配对。对方当前不在线，未能送达通知；它下次尝试操作时会自动解除。`
        : `已解除与 ${device.deviceName} 的配对，对方已同步解除。`
    );
    refresh();
  };

  const defaultBroadcast = (ip) => {
    const parts = String(ip || '').split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.255` : '';
  };

  const openWolEdit = (device) => {
    const saved = wolTargets[device.deviceId];
    setWolDraft({
      targetMac: saved?.targetMac || '',
      broadcast: saved?.broadcastAddresses?.[0] || defaultBroadcast(device.network?.preferredAddress),
    });
    setWolEditing(device.deviceId);
  };

  const saveWol = async (device) => {
    const result = await window.api.wol.saveTarget({
      deviceId: device.deviceId,
      targetMac: wolDraft.targetMac,
      broadcastAddresses: wolDraft.broadcast ? [wolDraft.broadcast] : [],
    });
    if (result.ok) {
      setNotice(`已保存「${device.deviceName}」的远程唤醒配置，可在它关机后尝试唤醒验证。`);
      setWolEditing(null);
      refresh();
    } else {
      setNotice(result.reasonCode === 'MAC_INVALID' ? 'MAC 地址格式不对，请检查后重试。' : '保存失败，请重试。');
    }
  };

  const wakeDevice = async (device) => {
    setWaking(device.deviceId);
    try {
      const result = await window.api.wol.send({ deviceId: device.deviceId });
      setNotice(
        result.online
          ? `「${device.deviceName}」已唤醒上线。`
          : `唤醒包已发送，但「${device.deviceName}」暂未上线。请确认：电源已插好、BIOS 已开启远程唤醒、使用有线网络。`
      );
      refresh();
    } catch (err) {
      setNotice(`唤醒失败：${err.message || '未知错误'}`);
    } finally {
      setWaking('');
    }
  };

  return (
    <section className="device-center app-page-surface">
      <div className="device-center-head">
        <div>
          <h2>设备中心</h2>
          <p>查看本机与已发现的 InnerBridge 设备；敏感操作需先完成配对。</p>
        </div>
        <button className="btn" onClick={refresh}>
          重新发现
        </button>
      </div>

      {incoming.map((item) => (
        <div className="pairing-notice" key={item.sessionId}>
          <strong>{item.fromDeviceName}</strong> 请求与本机配对。请在对方设备上确认显示的是同一个配对码：
          <strong className="mono">{item.code}</strong>
          <button className="btn small" onClick={() => confirmIncoming(item)}>
            配对码一致，允许
          </button>
          <button
            className="btn small"
            onClick={async () => {
              await window.api.pairing.rejectIncoming({ sessionId: item.sessionId });
              setIncoming((all) => all.filter((x) => x.sessionId !== item.sessionId));
            }}
          >
            拒绝
          </button>
        </div>
      ))}

      {pairing?.state === 'pending' && (
        <div className="pairing-notice">
          正在与 <strong>{pairing.deviceName}</strong> 配对，请确认对方设备显示相同配对码：
          <strong className="mono">{pairing.code}</strong>
        </div>
      )}

      <div className="device-grid">
        {devices.map((d) => {
          const isLocal = d.deviceId === localDeviceId;
          const revokedName = revokedBy[d.deviceId] || '';
          return (
            <article className="device-card" key={d.deviceId}>
              <div className="device-card-title">
                <span className="device-type-icon">
                  {d.deviceType === 'laptop' ? '💻' : d.platform === 'win32' ? '🖥️' : '▣'}
                </span>
                <div>
                  <h3>{d.deviceName}</h3>
                  <small>{d.hostname || d.platform}</small>
                </div>
              </div>
              <div className={`device-state ${revokedName ? 'offline' : d.presence?.online ? 'online' : 'offline'}`}>
                {statusText(d, isLocal, revokedName)}
              </div>
              <dl>
                <dt>地址</dt>
                <dd>{d.network?.preferredAddress || '本机'}</dd>
                <dt>设备 ID</dt>
                <dd className="mono">{d.deviceId}</dd>
              </dl>
              <div className="device-capabilities">
                {Object.entries(d.capabilities || {})
                  .filter(([, c]) => c.supported)
                  .map(([name, c]) => (
                    <span key={name} className={`capability-badge ${c.available ? 'cap-on' : 'cap-off'}`} title={c.reasonCode || ''}>
                      {CAPABILITY_META[name] || name}
                      <small>{capabilityStatus(c)}</small>
                    </span>
                  ))}
              </div>
              {isLocal && localNics.length > 0 && (
                <div className="nic-list">
                  <small>本机网卡 MAC（供其他设备配置远程唤醒时复制）：</small>
                  {localNics.map((n) => (
                    <div key={`${n.name}-${n.mac}`} className="nic-row">
                      <div className="nic-meta">
                        <strong>{n.name}</strong>
                        <span>{n.address}{n.family ? ` · ${n.family}` : ''}</span>
                      </div>
                      <code className="mono nic-mac">{n.mac}</code>
                      <button className="btn small" onClick={() => navigator.clipboard?.writeText(n.mac)}>复制</button>
                    </div>
                  ))}
                </div>
              )}
              {!isLocal && d.trust?.state !== 'trusted' && d.trust?.state !== 'identity_changed' && (
                <button className="btn small" onClick={() => requestPairing(d)}>
                  {revokedName ? '重新配对' : '发起配对'}
                </button>
              )}
              {!isLocal && d.trust?.state === 'trusted' && (
                <button className="btn small danger" onClick={() => unpair(d)}>
                  解除配对
                </button>
              )}
              {!isLocal && d.trust?.state === 'trusted' && (() => {
                const target = wolTargets[d.deviceId];
                const wolReady = target?.state === 'verified' || target?.state === 'configured';
                return (
                  <div className="wol-block">
                    {wolEditing === d.deviceId ? (
                      <div className="wol-form">
                        <label>
                          目标 MAC
                          <input
                            value={wolDraft.targetMac}
                            placeholder="AA-BB-CC-DD-EE-FF"
                            onChange={(e) => setWolDraft({ ...wolDraft, targetMac: e.target.value })}
                          />
                        </label>
                        <label>
                          广播地址
                          <input
                            value={wolDraft.broadcast}
                            placeholder="192.168.31.255"
                            onChange={(e) => setWolDraft({ ...wolDraft, broadcast: e.target.value })}
                          />
                        </label>
                        <p className="hint">MAC 可在目标设备「设备中心」的本机网卡区复制；BIOS 需开启远程唤醒（WOL），建议使用有线网络。</p>
                        <div className="wol-actions">
                          <button className="btn small primary" onClick={() => saveWol(d)}>保存</button>
                          <button className="btn small ghost" onClick={() => setWolEditing(null)}>取消</button>
                        </div>
                      </div>
                    ) : wolReady ? (
                      <>
                        <div className="wol-row">
                          <small>
                            远程唤醒（WOL）已配置
                            {target.state === 'verified' ? ' · 已验证可唤醒' : ' · 尚未实际验证'}
                          </small>
                          <button className="btn small ghost" onClick={() => openWolEdit(d)}>修改</button>
                        </div>
                        {!d.presence?.online && (
                          <button className="btn small" disabled={waking === d.deviceId} onClick={() => wakeDevice(d)}>
                            {waking === d.deviceId ? '唤醒中…（最长等 30 秒）' : '唤醒设备'}
                          </button>
                        )}
                      </>
                    ) : (
                      <button className="btn small ghost" onClick={() => openWolEdit(d)}>设置远程唤醒</button>
                    )}
                  </div>
                );
              })()}
              {d.trust?.state === 'identity_changed' && (
                <span className="cap-off">为保护数据安全，请先解除配对后重新配对</span>
              )}
            </article>
          );
        })}
      </div>

      <div className="lan-devices">
        <h3>访问过本机的设备</h3>
        <p className="hint">
          只有访问过本机服务的设备才会出现在这里（如拉取共享清单、群聊发言、文件同步）。
          不主动扫描网络；设备名取自已配对信息，未配对设备仅显示短标识。
        </p>
        {accessLog.length === 0 ? (
          <p className="hint">暂无记录。当其他设备访问本机的共享、群聊或同步服务后会自动出现。</p>
        ) : (
          <table className="lan-table">
            <thead>
              <tr><th>设备</th><th>IP</th><th>来源</th><th>最近访问</th></tr>
            </thead>
            <tbody>
              {accessLog.map((r, i) => {
                const known = devices.find((d) => d.deviceId === r.requesterId);
                const kindLabel = r.kind === 'chat' ? '群聊' : r.kind === 'share' ? '共享清单' : r.kind === 'sync' ? '文件同步' : (r.kind || '未知');
                return (
                  <tr key={`${r.requesterId}-${i}`}>
                    <td className="mono">{known?.deviceName || known?.name || r.name || `${r.requesterId.slice(0, 8)}…`}</td>
                    <td className="mono">{r.ip}</td>
                    <td>{kindLabel}</td>
                    <td>{new Date(r.at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {notice && <div className="chat-empty">{notice}</div>}
    </section>
  );
}
