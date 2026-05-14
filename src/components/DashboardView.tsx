import type { FC } from 'react';
import { IconActivity } from './Icons';
import { useI18n } from '../i18n';

export const DashboardView: FC = () => {
  const { t } = useI18n();

  return (
    <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <div className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">{t('dashboard.cpuLoad')}</div>
          <div className="text-3xl font-bold text-white font-mono">12.4%</div>
        </div>
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <div className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">{t('dashboard.bufferStatus')}</div>
          <div className="text-3xl font-bold text-indigo-400 font-mono">{t('dashboard.bufferNormal')}</div>
        </div>
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <div className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mb-2">{t('dashboard.uptime')}</div>
          <div className="text-3xl font-bold text-emerald-400 font-mono">14:22:01</div>
        </div>
      </div>

      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
        <div className="flex items-center gap-2 mb-6">
          <IconActivity />
          <h3 className="font-bold text-white">{t('dashboard.heartbeat')}</h3>
        </div>
        <div className="h-48 w-full bg-slate-950 rounded-xl flex items-end gap-1 p-4 border border-slate-800">
          {[30, 45, 35, 70, 50, 40, 60, 80, 45, 55, 90, 40, 30, 60, 75, 45, 55, 65, 40, 35].map((h, i) => (
            <div key={i} className="flex-1 bg-indigo-500/40 rounded-t-sm" style={{ height: `${h}%` }}></div>
          ))}
        </div>
      </div>
    </div>
  );
};
