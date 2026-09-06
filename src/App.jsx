import React, { useEffect, useRef, useState } from 'react';
import ShareManager from './components/ShareManager.jsx';
import MountManager from './components/MountManager.jsx';
import ChatPage from './components/ChatPage.jsx';
import LogPage from './components/LogPage.jsx';
import DeviceCenter from './components/DeviceCenter.jsx';
import ServiceSettings from './components/ServiceSettings.jsx';
import TransferPage from './components/TransferPage.jsx';
import SyncPage from './components/SyncPage.jsx';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[App] 渲染错误:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="loading">
          <p>界面出现错误：</p>
          <pre style={{ whiteSpace: 'pre-wrap', padding: '0 24px', color: 'var(--danger)', fontSize: 12 }}>
            {String((this.state.error && this.state.error.stack) || this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const THEME_KEY = 'inner-net-theme';

const THEME_LABEL = {
  auto: '跟随系统',
  light: '亮色',
  dark: '暗色',
};

export default function App() {
  const [sys, setSys] = useState(null);
  const [tab, setTab] = useState('devices');
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'auto');
  const [peerAlert, setPeerAlert] = useState(null);
  const [syncInvitation, setSyncInvitation] = useState(null);
  const contentRef = useRef(null);

  // 应用主题到 <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    window.api.getSysInfo().then(setSys).catch(console.error);
  }, []);

  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [tab]);

  // 跨端重要事件提升到应用根层监听，确保用户停留在任意页签都能看到。
  useEffect(() => {
    const offRevoked = window.api.pairing?.onRevoked?.(({ deviceName, deviceId }) => {
      setPeerAlert({
        kind: 'pairing',
        title: '设备配对已解除',
        message: `「${deviceName || deviceId}」已解除与本机的配对。如需继续传输、同步或远程操作，请重新配对。`,
      });
    });
    const offSync = window.api.sync?.onState?.((state) => {
      if (state?.invitation) {
        setSyncInvitation(state.invitation);
        setTab('sync');
        return;
      }
      if (!state?.notice) return;
      setPeerAlert({
        kind: 'sync',
        title: '文件同步已由对端停止',
        message: state.notice.message || `对端已停止同步任务「${state.notice.taskName || '未命名任务'}」。`,
      });
    });
    return () => { offRevoked?.(); offSync?.(); };
  }, []);

  if (!sys) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>正在加载系统信息…</p>
      </div>
    );
  }

  const isWin = sys.platform === 'win32';

  return (
    <ErrorBoundary>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◇</span>
          <div>
            <h1>InnerBridge</h1>
            <p className="host">
              {sys.hostname} · {sys.platform === 'win32' ? 'Windows 共享端' : 'macOS 挂载端'}
            </p>
          </div>
        </div>
        {isWin && (
          <div className="ipbar">
            {sys.ips.map((n) => (
              <span key={n.ip} className="chip">
                {n.ip}
              </span>
            ))}
            <span className={`badge ${sys.isAdmin ? 'ok' : 'warn'}`}>
              {sys.isAdmin ? '管理员' : '普通权限'}
            </span>
          </div>
        )}
        <button
          className="theme-btn"
          title={`主题：${THEME_LABEL[theme]}（点击切换）`}
          onClick={() => setTheme((p) => (p === 'auto' ? 'light' : p === 'light' ? 'dark' : 'auto'))}
        >
          <span className="theme-icon">{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</span>
          <span className="theme-text">{THEME_LABEL[theme]}</span>
        </button>
      </header>

      {isWin && !sys.isAdmin && (
        <div className="permission-warning" role="alert">
          当前以普通权限运行，创建/修复 SMB 共享、ACL 等功能会受限。请退出程序后右键选择“以管理员身份运行”。
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'devices' ? 'on' : ''} onClick={() => setTab('devices')}>设备中心</button>
        <button
          className={tab === 'main' ? 'on' : ''}
          onClick={() => setTab('main')}
        >
          {isWin ? '共享文件夹' : '聚合挂载'}
        </button>
        <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
          群聊
        </button>
        <button className={tab === 'transfer' ? 'on' : ''} onClick={() => setTab('transfer')}>P2P传输</button>
        <button className={tab === 'sync' ? 'on' : ''} onClick={() => setTab('sync')}>文件同步</button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
          运行日志
        </button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>服务设置</button>
      </nav>

      <main className="content" ref={contentRef}>
        {tab === 'devices'
          ? <DeviceCenter />
          : tab === 'main'
          ? isWin
            ? <ShareManager sys={sys} />
            : <MountManager sys={sys} />
          : tab === 'chat'
            ? <ChatPage isWin={isWin} />
            : tab === 'settings'
              ? <ServiceSettings />
              : tab === 'transfer'
                ? <TransferPage />
                : tab === 'sync'
                ? <SyncPage invitation={syncInvitation} onInvitationHandled={() => setSyncInvitation(null)} />
              : <LogPage />}
      </main>

      {peerAlert && (
        <div className="modal-mask app-alert-mask" role="presentation">
          <div className="modal app-alert" role="alertdialog" aria-modal="true" aria-labelledby="peer-alert-title">
            <span className={`app-alert-icon ${peerAlert.kind}`} aria-hidden="true">
              {peerAlert.kind === 'pairing' ? '!' : '↕'}
            </span>
            <div className="app-alert-copy">
              <h3 id="peer-alert-title">{peerAlert.title}</h3>
              <p>{peerAlert.message}</p>
            </div>
            <button className="btn primary" autoFocus onClick={() => setPeerAlert(null)}>我知道了</button>
          </div>
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}
