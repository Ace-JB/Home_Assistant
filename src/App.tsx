import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { LiveView } from './components/LiveView';
import { useRealtimeFeedback } from './hooks/useRealtimeFeedback';

const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [currentTime, setCurrentTime] = useState(new Date());
  const realtime = useRealtimeFeedback();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex w-screen h-screen bg-slate-950 text-slate-200 font-sans overflow-hidden">
      {/* 侧边栏 */}
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

      {/* 主内容 */}
      <main className="flex-1 flex flex-col min-w-0 relative">
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

export default App;
