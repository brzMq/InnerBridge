import React, { useEffect, useState } from 'react';
import ShareManager from './components/ShareManager.jsx';
import MountManager from './components/MountManager.jsx';
import ChatPage from './components/ChatPage.jsx';
import LogPage from './components/LogPage.jsx';
import DeviceCenter from './components/DeviceCenter.jsx';
import ServiceSettings from './components/ServiceSettings.jsx';
import TransferPage from './components/TransferPage.jsx';

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
            <h1>InnerNet 内网共享</h1>
            <p className="host">
              {sys.hostname} · {sys.platform === 'win32' ? 'Windows 共享端' : 'macOS 挂载端'}
            </p>
          </div>
        </div>
        {isWin ? (
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
        ) : (
          <div className="ipbar">
            <span className="badge neutral">无需管理员</span>
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
          当前以普通权限运行，创建/修复 SMB 共享、ACL 和 SSH 服务等功能会受限。请退出程序后右键选择“以管理员身份运行”。
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
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
          运行日志
        </button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>服务设置</button>
      </nav>

      <main className="content">
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
              : <LogPage />}
      </main>
    </div>
    </ErrorBoundary>
  );
}
