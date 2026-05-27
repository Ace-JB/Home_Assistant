import { useRealtimeFeedback } from '../../../hooks/useRealtimeFeedback';
import { AudioRealtimePanel } from '../../../components/live/AudioRealtimePanel';
import { DemoPageShell } from '../../../components/live/DemoPageShell';
import { StatusCard } from '../../../components/live/StatusCard';

export function AudioASRDemo() {
  const realtime = useRealtimeFeedback();

  return (
    <DemoPageShell
      title="/demo/audio"
      description="语音模块独立验证页，实时展示语音转文字结果。"
      status={
        <>
          <div>module: audio</div>
          <div>socket: {realtime.connected ? 'connected' : 'disconnected'}</div>
          <div>audio: {realtime.audioLevel}%</div>
        </>
      }
    >
      <section className="grid gap-4 md:grid-cols-3">
        <StatusCard label="验证目标" value="语音转文字、音量变化和持续识别内容。" />
        <StatusCard label="当前来源" value="本地麦克风 / FunASR 实时识别" />
        <StatusCard label="输出" value="音量条 / 最新文本 / 历史记录" />
      </section>

      <AudioRealtimePanel
        connected={realtime.connected}
        audioLevel={realtime.audioLevel}
        transcript={realtime.transcript}
        transcriptHistory={realtime.transcriptHistory}
        title="Audio ASR Module"
        showConnection
        showHistory
      />
    </DemoPageShell>
  );
}
