import type { FC } from 'react';
import type { TranscriptEntry } from '../../types/realtime';
import { useI18n } from '../../i18n';
import { formatDurationMs, formatPercent } from './format';

export type AudioRealtimePanelProps = {
  connected?: boolean;
  audioLevel: number;
  transcript: string;
  transcriptHistory?: TranscriptEntry[];
  title?: string;
  showConnection?: boolean;
  showHistory?: boolean;
  className?: string;
};

export const AudioRealtimePanel: FC<AudioRealtimePanelProps> = ({
  connected,
  audioLevel,
  transcript,
  transcriptHistory = [],
  title,
  showConnection = false,
  showHistory = false,
  className = '',
}) => {
  const { t } = useI18n();
  const level = formatPercent(audioLevel);

  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/70 p-4 text-slate-100 ${className}`}>
      {(title || showConnection) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title ? <h3 className="text-sm font-semibold text-white">{title}</h3> : <span />}
          {showConnection ? (
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${
              connected
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            }`}>
              {connected ? 'socket connected' : 'socket disconnected'}
            </span>
          ) : null}
        </div>
      )}

      <div className={showHistory ? 'grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]' : 'space-y-4'}>
        <div className="space-y-4">
          <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wide text-slate-500">{t('live.voiceActivity')}</div>
              <div className="text-xs text-emerald-300">{level}</div>
            </div>
            <div className="mt-3 h-3 overflow-hidden rounded-full border border-slate-800 bg-slate-900">
              <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: level }} />
            </div>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Latest Transcript</div>
            <div className="mt-3 min-h-16 whitespace-pre-wrap text-sm leading-6 text-slate-100">
              {transcript || t('live.listening')}
            </div>
          </div>
        </div>

        {showHistory ? (
          <aside className="rounded-md border border-slate-800 bg-slate-950 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Transcript History</div>
            <div className="mt-3 space-y-2">
              {transcriptHistory.length === 0 ? (
                <div className="text-sm text-slate-500">暂无识别历史。</div>
              ) : (
                transcriptHistory.slice().reverse().map((item) => (
                  <div key={`${item.ts}-${item.startTs}`} className="rounded border border-slate-800 bg-slate-900 p-3">
                    <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                      <span>{new Date(item.ts).toLocaleTimeString()}</span>
                      <span>{formatDurationMs(item.startTs, item.endTs)}</span>
                    </div>
                    <div className="mt-2 text-sm text-slate-100">{item.text}</div>
                  </div>
                ))
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
};
