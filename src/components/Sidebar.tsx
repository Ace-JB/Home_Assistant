import { type FC } from 'react';
import { IconDashboard, IconVideo, IconBell, IconSettings, IconZap } from './Icons';
import { useI18n } from '../i18n';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export const Sidebar: FC<SidebarProps> = ({ activeTab, setActiveTab }) => {
  const { t } = useI18n();

  return (
    <aside className="w-[260px] bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-indigo-600 p-2 rounded-lg flex items-center justify-center">
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
          <span className="text-sm font-medium">{t('sidebar.dashboard')}</span>
        </button>
        <button
          onClick={() => setActiveTab('live')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === 'live' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
        >
          <IconVideo />
          <span className="text-sm font-medium">{t('sidebar.live')}</span>
        </button>
        <div className="flex items-center gap-3 px-4 py-3 text-slate-500 opacity-50 cursor-not-allowed">
          <IconBell />
          <span className="text-sm font-medium">{t('sidebar.history')}</span>
        </div>
        <div className="flex items-center gap-3 px-4 py-3 text-slate-500 opacity-50 cursor-not-allowed">
          <IconSettings />
          <span className="text-sm font-medium">{t('sidebar.settings')}</span>
        </div>
      </nav>

      <div className="p-4 bg-slate-800/30 m-4 rounded-xl border border-slate-700/50">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
          <span className="text-xs font-medium text-slate-300 uppercase">{t('sidebar.systemOnline')}</span>
        </div>
        <p className="text-[10px] text-slate-500 font-mono uppercase">{t('sidebar.ffmpegActive')}</p>
      </div>
    </aside>
  );
};
