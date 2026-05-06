import { type CSSProperties, useEffect, useState } from 'react';

// --- 彻底稳定的内联图标：硬编码宽高，防止渲染异常时尺寸溢出 ---
const IconZap = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ minWidth: '24px' }}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
);
const IconDashboard = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
);
const IconVideo = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8Z"></path><rect width="14" height="12" x="2" y="6" rx="2" ry="2"></rect></svg>
);
const IconBell = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>
);
const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
);
const IconActivity = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>
);

// --- 样式定义：使用标准内联样式作为兜底 ---
const styles: Record<string, CSSProperties> = {
  container: {
    display: 'flex',
    width: '100vw',
    height: '100vh',
    backgroundColor: '#020617', // slate-950
    color: '#e2e8f0', // slate-200
    fontFamily: 'system-ui, -apple-system, sans-serif',
    overflow: 'hidden',
  },
  sidebar: {
    width: '260px',
    backgroundColor: '#0f172a', // slate-900
    borderRight: '1px solid #1e293b',
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    position: 'relative',
  }
};

const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={styles.container}>
      {/* 侧边栏 */}
      <aside style={styles.sidebar}>
        <div className="p-6 flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <IconZap />
          </div>
          <span className="font-bold text-xl text-white">AI Agent</span>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'dashboard' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <IconDashboard />
            <span className="text-sm font-medium">控制面板</span>
          </button>
          <button
            onClick={() => setActiveTab('live')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'live' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
          >
            <IconVideo />
            <span className="text-sm font-medium">实时流查看</span>
          </button>
          <div className="flex items-center gap-3 px-4 py-3 text-slate-500 opacity-50 cursor-not-allowed">
            <IconBell />
            <span className="text-sm font-medium">历史记录</span>
          </div>
          <div className="flex items-center gap-3 px-4 py-3 text-slate-500 opacity-50 cursor-not-allowed">
            <IconSettings />
            <span className="text-sm font-medium">系统配置</span>
          </div>
        </nav>

        <div className="p-4 bg-slate-800/30 m-4 rounded-xl border border-slate-700/50">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
            <span className="text-xs font-medium text-slate-300">SYSTEM ONLINE</span>
          </div>
          <p className="text-[10px] text-slate-500 font-mono">FFMPEG CORE ACTIVE</p>
        </div>
      </aside>

      {/* 主内容 */}
      <main style={styles.main}>
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-900/50">
          <h2 className="text-lg font-semibold text-white">
            {activeTab === 'dashboard' ? '系统概览' : '实时监控'}
          </h2>
          <div className="text-sm font-mono text-slate-400 bg-slate-900 px-3 py-1 rounded border border-slate-800">
            {currentTime.toLocaleTimeString()}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          {activeTab === 'dashboard' ? <DashboardView /> : <LiveView />}
        </div>
      </main>
    </div>
  );
};

const DashboardView = () => (
  <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">CPU 负载</div>
        <div className="text-3xl font-bold text-white font-mono">12.4%</div>
      </div>
      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">缓冲区状态</div>
        <div className="text-3xl font-bold text-indigo-400 font-mono">Normal</div>
      </div>
      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">运行时间</div>
        <div className="text-3xl font-bold text-emerald-400 font-mono">14:22:01</div>
      </div>
    </div>

    <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
      <div className="flex items-center gap-2 mb-6">
        <IconActivity />
        <h3 className="font-bold text-white">感知心跳频率</h3>
      </div>
      <div className="h-48 w-full bg-slate-950 rounded-xl flex items-end gap-1 p-4 border border-slate-800">
        {[30, 45, 35, 70, 50, 40, 60, 80, 45, 55, 90, 40, 30, 60, 75, 45, 55, 65, 40, 35].map((h, i) => (
          <div key={i} className="flex-1 bg-indigo-500/40 rounded-t-sm" style={{ height: `${h}%` }}></div>
        ))}
      </div>
    </div>
  </div>
);

const LiveView = () => (
  <div className="max-w-5xl mx-auto space-y-6 animate-in slide-in-from-bottom-4 duration-500">
    <div className="aspect-video bg-black rounded-3xl border-4 border-slate-800 flex items-center justify-center relative shadow-2xl overflow-hidden">
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p className="text-slate-600 font-mono text-[10px] uppercase tracking-widest">Waiting for Sync Manager...</p>
      </div>
      <div className="absolute top-6 left-6 bg-black/60 px-3 py-1 rounded-full border border-white/10 flex items-center gap-2">
        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
        <span className="text-[10px] font-bold text-white">LIVE</span>
      </div>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 font-mono text-[11px]">
      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div className="text-slate-500 uppercase mb-4">Pipeline Params</div>
        <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
          <span>Encoder</span>
          <span className="text-white">libx264</span>
        </div>
        <div className="flex justify-between">
          <span>Resolution</span>
          <span className="text-white">640x480</span>
        </div>
      </div>
      <div className="flex items-center justify-center bg-indigo-600/10 rounded-2xl border border-indigo-500/20 p-6">
        <button className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-8 py-3 rounded-xl transition-all active:scale-95 text-xs uppercase tracking-widest">
          Manual Trigger Recording
        </button>
      </div>
    </div>
  </div>
);

export default App;
