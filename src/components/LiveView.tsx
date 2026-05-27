import { type FC } from 'react';
import { SentinelMonitor } from './SentinelMonitor';
import type { RealtimeState } from '../types/realtime';
import { AudioRealtimePanel } from './live/AudioRealtimePanel';
import { HumanPerceptionPanel } from './live/HumanPerceptionPanel';
import { PipelineInfoPanel } from './live/PipelineInfoPanel';

// ─── Main View ─────────────────────────────────────────────────────────────

export const LiveView: FC<{ realtime: RealtimeState }> = ({ realtime }) => {
  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-center relative group">
        <SentinelMonitor />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 font-mono text-[11px]">
        <PipelineInfoPanel />
        <AudioRealtimePanel
          audioLevel={realtime.audioLevel}
          transcript={realtime.transcript}
          className="rounded-2xl border-indigo-500/20 bg-indigo-600/10 p-6"
        />
      </div>

      <HumanPerceptionPanel detection={realtime.visionDetection} />
    </div>
  );
};
