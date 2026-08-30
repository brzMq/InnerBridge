/* global setInterval, clearInterval */
import React, { useEffect, useState } from 'react';

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
  const [codes, setCodes] = useState({});
  const [notice, setNotice] = useState('');
  const [revokedBy, setRevokedBy] = useState({});
  const [lanDevices, setLanDevices] = useState([]);
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
    window.api.lan?.list?.().then(setLanDevices).catch(() => {});
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
    const result = await window.api.pairing.confirmIncoming({ sessionId: item.sessionId, code: codes[item.sessionId] || '' });
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
    <section className="device-center">
      <div className="device-center-head">
        <div>
          <h2>设备中心</h2>
          <p>查看本机与已发现的 InnerNet 设备；敏感操作需先完成配对。</p>
        </div>
        <button className="btn" onClick={refresh}>
          重新发现
        </button>
      </div>

      {incoming.map((item) => (
        <div className="pairing-notice" key={item.sessionId}>
          <strong>{item.fromDeviceName}</strong> 请求与本机配对。请确认两端显示的配对码一致：
          <strong>{item.code}</strong>
          <input
            aria-label="配对验证码"
            value={codes[item.sessionId] || ''}
            maxLength={6}
            onChange={(e) => setCodes({ ...codes, [item.sessionId]: e.target.value.replace(/\D/g, '') })}
          />
          <button className="btn small" onClick={() => confirmIncoming(item)}>
            允许配对
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
                    <span key={name} className={c.available ? 'cap-on' : 'cap-off'}>
                      {name}
                      {c.available ? ' 可用' : ' 未就绪'}
                    </span>
                  ))}
              </div>
              {isLocal && localNics.length > 0 && (
                <div className="nic-list">
                  <small>本机网卡 MAC（供其他设备配置远程唤醒时复制）：</small>
                  {localNics.map((n) => (
                    <div key={`${n.name}-${n.mac}`} className="nic-row">
                      <span>{n.name}（{n.address}）</span>
                      <code className="mono">{n.mac}</code>
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
        <h3>局域网其他设备（未安装 InnerNet）</h3>
        {lanDevices.length === 0 ? (
          <p className="hint">
            暂未发现。只有与本机产生过网络流量的设备才会出现在 ARP 表里（如访问过共享、被路由器广播过）。
            本列表只读、不主动扫描网络，不会对任何设备发包。
          </p>
        ) : (
          <table className="lan-table">
            <thead>
              <tr><th>IP 地址</th><th>MAC 地址</th><th>厂商（推断）</th></tr>
            </thead>
            <tbody>
              {lanDevices.map((d) => (
                <tr key={d.ip}>
                  <td className="mono">{d.ip}</td>
                  <td className="mono">{d.mac}</td>
                  <td>{d.vendor || '未知'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {notice && <div className="chat-empty">{notice}</div>}
    </section>
  );
}
