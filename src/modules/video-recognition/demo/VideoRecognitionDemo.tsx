import { ModuleErrorBoundary } from '../../../shared/ui/ModuleErrorBoundary';
import { SentinelMonitor } from '../../../components/SentinelMonitor';
import { HumanPerceptionPanel } from '../../../components/live/HumanPerceptionPanel';
import { useRealtimeFeedback } from '../../../hooks/useRealtimeFeedback';
import { DemoPageShell } from '../../../components/live/DemoPageShell';
import { StatusCard } from '../../../components/live/StatusCard';

export function VideoRecognitionDemo() {
  const realtime = useRealtimeFeedback();

  return (
    <DemoPageShell
      title="/demo/video"
      description="独立视频验证页，直接查看 WebRTC 实时回显和 Human 识别结果。"
      status={
        <>
          <div>module: video</div>
          <div>socket: {realtime.connected ? 'connected' : 'disconnected'}</div>
          <div>faces: {realtime.visionDetection?.faces.length ?? 0}</div>
        </>
      }
    >
      <section className="grid gap-4 md:grid-cols-3">
        <StatusCard label="验证目标" value="WebRTC 回显 + 人脸/身体/手部/物体识别结果。" />
        <StatusCard label="输入源" value="本地摄像头 / WebRTC 实时流" />
        <StatusCard label="输出" value="预览画面 / 识别结果卡片 / 实时状态" />
      </section>

      <ModuleErrorBoundary moduleName="VideoRecognitionModule">
        <div className="space-y-4">
          <SentinelMonitor />
          <HumanPerceptionPanel detection={realtime.visionDetection} />
        </div>
      </ModuleErrorBoundary>
    </DemoPageShell>
  );
}
