import { type FC, useState } from 'react';
import { SentinelMonitor } from './SentinelMonitor';
import { IconActivity, IconMore } from './Icons';
import type { RealtimeState } from '../types/realtime';

export const LiveView: FC<{ realtime: RealtimeState }> = ({ realtime }) => (
  <div className="max-w-5xl mx-auto space-y-6 animate-in slide-in-from-bottom-4 duration-500">
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

const VideoToolMenu: FC<{ realtime: RealtimeState }> = ({ realtime }) => {
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
