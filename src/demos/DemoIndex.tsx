import { DemoPageShell } from '../components/live/DemoPageShell';
import { StatusCard } from '../components/live/StatusCard';

const demos = [
  {
    href: '/demo/video',
    title: 'VideoRecognitionModule',
    description: '独立视频识别模块验证页，展示实时 WebRTC 回显和识别结果。',
    status: 'ready',
  },
  {
    href: '/demo/audio',
    title: 'AudioASRModule',
    description: '独立语音识别模块验证页，展示实时音量和 FunASR 识别文本。',
    status: 'ready',
  },
] as const;

export function DemoIndex() {
  return (
    <DemoPageShell
      title="模块验证中心"
      description="每个模块都可以单独打开，在浏览器里直接看到运行状态、输入输出和结果面板。"
      status={
        <>
          <div>mode: demo</div>
          <div>modules: {demos.length}</div>
        </>
      }
    >
      <section className="grid gap-4 md:grid-cols-2">
        {demos.map((demo) => (
          <a
            key={demo.href}
            href={demo.href}
            className="rounded-lg border border-slate-800 bg-slate-900/70 p-4 transition hover:border-indigo-500/60 hover:bg-slate-900"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">{demo.title}</h2>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                {demo.status}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-400">{demo.description}</p>
            <div className="mt-4 text-sm font-medium text-indigo-300">打开演示</div>
          </a>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <StatusCard label="视频入口" value="bun run dev:video" detail="/demo/video" />
        <StatusCard label="语音入口" value="bun run dev:audio" detail="/demo/audio" />
        <StatusCard label="完整入口" value="bun run dev" detail="/demo 可查看全部模块" />
      </section>
    </DemoPageShell>
  );
}
