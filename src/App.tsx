import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { LiveView } from './components/LiveView';
import { MemoryView } from './components/MemoryView';
import { VoiceControlView } from './components/VoiceControlView';
import { ModelRecallLogsView } from './components/ModelRecallLogsView';
import { DemoRouter } from './demos/DemoRouter';
import { useRealtimeFeedback } from './hooks/useRealtimeFeedback';
import { useI18n, type Language } from './i18n';

type AppTab = 'dashboard' | 'live' | 'memory' | 'voice' | 'logs';

const App = () => {
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
  const [currentTime, setCurrentTime] = useState(new Date());
  const realtime = useRealtimeFeedback();
  const { language, setLanguage, t } = useI18n();

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    realtime.setLanguage(language);
  }, [language]);

  return (
    <DemoRouter>
    <div className="flex w-screen h-screen bg-slate-950 text-slate-200 font-sans overflow-hidden">
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />

      <main className="flex-1 flex flex-col min-w-0 relative">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-900/50">
          <h2 className="text-lg font-semibold text-white">
            {getTabTitle(activeTab, t)}
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-lg border border-slate-800 bg-slate-900 p-1 text-xs">
              {(['zh', 'en'] as Language[]).map((nextLanguage) => (
                <button
                  key={nextLanguage}
                  type="button"
                  onClick={() => setLanguage(nextLanguage)}
                  className={`rounded-md px-3 py-1.5 font-medium transition ${
                    language === nextLanguage
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                  aria-pressed={language === nextLanguage}
                  aria-label={`${t('language.label')}: ${t(nextLanguage === 'zh' ? 'language.zh' : 'language.en')}`}
                >
                  {t(nextLanguage === 'zh' ? 'language.zh' : 'language.en')}
                </button>
              ))}
            </div>
            <div className="text-sm font-mono text-slate-400 bg-slate-900 px-3 py-1 rounded border border-slate-800">
              {currentTime.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          {activeTab === 'dashboard' && <DashboardView />}
          {activeTab === 'live' && <LiveView realtime={realtime} />}
          {activeTab === 'memory' && <MemoryView />}
          {activeTab === 'voice' && <VoiceControlView />}
          {activeTab === 'logs' && <ModelRecallLogsView />}
        </div>
      </main>
    </div>
    </DemoRouter>
  );
};

function getTabTitle(activeTab: AppTab, t: ReturnType<typeof useI18n>['t']): string {
  if (activeTab === 'dashboard') return t('app.title.dashboard');
  if (activeTab === 'live') return t('app.title.live');
  if (activeTab === 'voice') return t('app.title.voice');
  if (activeTab === 'logs') return t('app.title.logs');
  return t('app.title.memory');
}

export default App;
