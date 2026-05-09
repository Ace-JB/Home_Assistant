import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { SentinelMonitor } from './components/SentinelMonitor';


type RealtimeMessage =
  | { type: 'socket.connected'; ts: number; clientId: string; clients: number; realtimeSubtitleEnabled: boolean }
  | { type: 'socket.status'; ts: number; clients: number; realtimeSubtitleEnabled: boolean }
  | { type: 'video.frame'; ts: number; mime: 'image/jpeg'; data: string }
  | { type: 'voice.level'; ts: number; bytes: number; rms: number; peak: number }
  | { type: 'voice.text'; ts: number; text: string; startTs: number; endTs: number };

type BufferedFrame = {
  ts: number;
  src: string;
};

type SubtitleCue = {
  startTs: number;
  endTs: number;
  text: string;
};

type RealtimeState = {
  connected: boolean;
  clients: number;
  frameSrc: string | null;
  audioLevel: number;
  transcript: string;
  activeSubtitle: string;
  subtitleEnabled: boolean;
  videoDelayMs: number;
  lastFrameAt: number | null;
  setRealtimeSubtitle: (enabled: boolean) => void;
  setVideoDelay: (delayMs: number) => void;
};

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
const IconMore = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
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
  const realtime = useRealtimeFeedback();

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
          {activeTab === 'dashboard' ? <DashboardView /> : <LiveView realtime={realtime} />}
        </div>
      </main>
    </div>
  );
};

function useRealtimeFeedback(): RealtimeState {
  const socketRef = useRef<WebSocket | null>(null);
  const frameQueueRef = useRef<BufferedFrame[]>([]);
  const subtitleCuesRef = useRef<SubtitleCue[]>([]);
  const [state, setState] = useState<RealtimeState>({
    connected: false,
    clients: 0,
    frameSrc: null,
    audioLevel: 0,
    transcript: '',
    activeSubtitle: '',
    subtitleEnabled: false,
    videoDelayMs: 5000,
    lastFrameAt: null,
    setRealtimeSubtitle: () => {},
    setVideoDelay: () => {},
  });

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const currentPort = Number(window.location.port || (window.location.protocol === 'https:' ? 443 : 80));
    const socketHost = `${window.location.hostname}:${currentPort + 1}`;
    const socket = new WebSocket(`${protocol}//${socketHost}/ws/realtime`);
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      setState((prev) => ({ ...prev, connected: true }));
    });

    socket.addEventListener('close', () => {
      setState((prev) => ({ ...prev, connected: false }));
    });

    socket.addEventListener('message', (event) => {
      let message: RealtimeMessage;

      try {
        message = JSON.parse(event.data) as RealtimeMessage;
      } catch {
        return;
      }

      setState((prev) => {
        if (message.type === 'socket.connected' || message.type === 'socket.status') {
          return {
            ...prev,
            connected: true,
            clients: message.clients,
            subtitleEnabled: message.realtimeSubtitleEnabled,
          };
        }

        if (message.type === 'video.frame') {
          // 视频现在通过 WebRTC 传输，不再使用 Socket 发送 JPEG
          return prev;
        }


        if (message.type === 'voice.level') {
          return {
            ...prev,
            audioLevel: Math.min(100, Math.round(message.rms * 500)),
          };
        }

        if (message.type === 'voice.text') {
          subtitleCuesRef.current.push({
            startTs: message.startTs,
            endTs: message.endTs,
            text: message.text,
          });
          subtitleCuesRef.current = subtitleCuesRef.current.slice(-40);
          return { ...prev, transcript: message.text };
        }

        return prev;
      });
    });

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setState((prev) => {
        const playbackTs = Date.now() - prev.videoDelayMs;
        let frameSrc = prev.frameSrc;
        let lastFrameAt = prev.lastFrameAt;

        while (frameQueueRef.current.length > 0 && frameQueueRef.current[0]!.ts <= playbackTs) {
          const frame = frameQueueRef.current.shift()!;
          frameSrc = frame.src;
          lastFrameAt = frame.ts;
        }

        frameQueueRef.current = frameQueueRef.current.filter((frame) => frame.ts >= playbackTs - 2000);
        subtitleCuesRef.current = subtitleCuesRef.current.filter((cue) => cue.endTs >= playbackTs - 5000);

        const activeCue = subtitleCuesRef.current.find((cue) => (
          cue.startTs <= playbackTs && playbackTs <= cue.endTs + 2500
        ));

        return {
          ...prev,
          frameSrc,
          lastFrameAt,
          activeSubtitle: activeCue?.text ?? '',
        };
      });
    }, 50);

    return () => clearInterval(timer);
  }, []);

  return {
    ...state,
    setRealtimeSubtitle: (enabled: boolean) => {
      setState((prev) => ({ ...prev, subtitleEnabled: enabled }));
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current?.send(JSON.stringify({ type: 'subtitle.enable', enabled }));
      }
    },
    setVideoDelay: (delayMs: number) => {
      frameQueueRef.current = [];
      setState((prev) => ({
        ...prev,
        videoDelayMs: delayMs,
        activeSubtitle: '',
      }));
    },
  };
}

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

const LiveView = ({ realtime }: { realtime: RealtimeState }) => (
  <div className="max-w-5xl mx-auto space-y-6 animate-in slide-in-from-bottom-4 duration-500">
    {/* 新的 WebRTC + AI Worker 监控架构 */}
    <div className="flex justify-center relative group">
      <SentinelMonitor />
      <VideoToolMenu realtime={realtime} />
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 font-mono text-[11px]">

      <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
        <div className="text-slate-500 uppercase mb-4">Pipeline Params</div>
        <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
          <span>Transport</span>
          <span className="text-white">WebRTC / RTP</span>
        </div>
        <div className="flex justify-between">
          <span>Encoder</span>
          <span className="text-white">VideoToolbox (H.264)</span>
        </div>
        <div className="flex justify-between border-t border-slate-800 pt-2 mt-2">
          <span>AI Backend</span>
          <span className="text-white">WebGL Worker</span>
        </div>
      </div>

      <div className="bg-indigo-600/10 rounded-2xl border border-indigo-500/20 p-6 space-y-4">
        <div className="text-slate-500 uppercase">Voice Activity</div>
        <div className="h-3 overflow-hidden rounded-full bg-slate-950 border border-slate-800">
          <div className="h-full bg-emerald-400 transition-all" style={{ width: `${realtime.audioLevel}%` }}></div>
        </div>
        <div className="text-slate-300 min-h-6">{realtime.transcript || 'Listening...'}</div>
      </div>
    </div>
  </div>
);

const VideoToolMenu = ({ realtime }: { realtime: RealtimeState }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="absolute right-5 top-5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white transition hover:bg-black/80"
        aria-label="Open live video tools"
      >
        <IconMore />
      </button>
      {expanded && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg border border-white/10 bg-slate-950/95 p-2 text-sm text-slate-200 shadow-2xl">
          <button
            type="button"
            onClick={() => realtime.setRealtimeSubtitle(!realtime.subtitleEnabled)}
            className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition hover:bg-slate-800"
          >
            <span>Real-time subtitle</span>
            <span className={`h-5 w-9 rounded-full p-0.5 transition ${realtime.subtitleEnabled ? 'bg-emerald-500' : 'bg-slate-700'}`}>
              <span className={`block h-4 w-4 rounded-full bg-white transition ${realtime.subtitleEnabled ? 'translate-x-4' : ''}`}></span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
