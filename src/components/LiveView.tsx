import { type FC, useState } from 'react';
import { SentinelMonitor } from './SentinelMonitor';
import { IconMore } from './Icons';
import type { RealtimeState, VisionDetection, FaceResult, BodyResult, HandResult, ObjectResult } from '../types/realtime';
import { useI18n, type TranslationKey } from '../i18n';

// ─── Main View ─────────────────────────────────────────────────────────────

export const LiveView: FC<{ realtime: RealtimeState }> = ({ realtime }) => {
  const { t } = useI18n();

  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-center relative group">
        <SentinelMonitor />
        <VideoToolMenu realtime={realtime} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 font-mono text-[11px]">
        <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
          <div className="text-slate-500 uppercase mb-4">{t('live.pipelineParams')}</div>
          <div className="flex justify-between border-b border-slate-800 pb-2 mb-2">
            <span>{t('live.transport')}</span>
            <span className="text-white">WebRTC / RTP</span>
          </div>
          <div className="flex justify-between">
            <span>{t('live.encoder')}</span>
            <span className="text-white">VideoToolbox (H.264)</span>
          </div>
          <div className="flex justify-between border-t border-slate-800 pt-2 mt-2">
            <span>{t('live.aiBackend')}</span>
            <span className="text-white">TensorFlow Node</span>
          </div>
        </div>

        <div className="bg-indigo-600/10 rounded-2xl border border-indigo-500/20 p-6 space-y-4">
          <div className="text-slate-500 uppercase">{t('live.voiceActivity')}</div>
          <div className="h-3 overflow-hidden rounded-full bg-slate-950 border border-slate-800">
            <div className="h-full bg-emerald-400 transition-all" style={{ width: `${realtime.audioLevel}%` }}></div>
          </div>
          <div className="text-slate-300 min-h-6">{realtime.transcript || t('live.listening')}</div>
        </div>
      </div>

      <HumanPerceptionPanel detection={realtime.visionDetection} />
    </div>
  );
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const EMOTION_EMOJI: Record<string, string> = {
  happy: '😊', sad: '😢', angry: '😠', fear: '😨',
  disgust: '🤢', surprise: '😲', neutral: '😐',
};

const HAND_EMOJI: Record<string, string> = {
  left: '🤚', right: '✋', unknown: '🖐️',
};

function pct(v: number) { return `${Math.round(Math.min(v, 1) * 100)}%`; }

const EMOTION_TRANSLATION_KEYS: Record<string, TranslationKey> = {
  happy: 'emotion.happy',
  sad: 'emotion.sad',
  angry: 'emotion.angry',
  fear: 'emotion.fear',
  disgust: 'emotion.disgust',
  surprise: 'emotion.surprise',
  neutral: 'emotion.neutral',
};

const HAND_TRANSLATION_KEYS: Record<string, TranslationKey> = {
  left: 'hand.left',
  right: 'hand.right',
  unknown: 'hand.unknown',
};

function isUnknownStrangerLabel(label: string): boolean {
  return label === '未知陌生人' || label.toLowerCase() === 'unknown stranger';
}

const ScoreBar: FC<{ score: number; color?: string }> = ({ score, color = 'bg-indigo-500' }) => (
  <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
    <div className={`h-full rounded-full transition-all duration-300 ${color}`} style={{ width: pct(score) }} />
  </div>
);

// ─── Face Card ─────────────────────────────────────────────────────────────

const FaceCard: FC<{ face: FaceResult; index: number }> = ({ face, index }) => {
  const { t } = useI18n();
  const topEmotion = face.emotions[0];
  const emoji = topEmotion ? (EMOTION_EMOJI[topEmotion.emotion] ?? '🙂') : '🙂';
  return (
    <div className="bg-slate-800/60 rounded-xl p-3 space-y-2 border border-slate-700/50">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">{emoji}</span>
          <span className={`font-bold text-[12px] ${face.matched ? 'text-emerald-400' : 'text-amber-400'}`}>
            {isUnknownStrangerLabel(face.label) ? t('live.unknownStranger') : face.label}
          </span>
        </div>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide ${
          face.matched ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
        }`}>
          {face.matched ? t('live.identified') : t('live.unknown')}
        </span>
      </div>

      {face.similarity !== null && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-slate-400">
            <span>{t('live.similarity')}</span>
            <span className="text-white">{pct(face.similarity)}</span>
          </div>
          <ScoreBar score={face.similarity} color={face.matched ? 'bg-emerald-500' : 'bg-amber-500'} />
        </div>
      )}

      {face.emotions.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {face.emotions.map(e => {
            const emotionKey = EMOTION_TRANSLATION_KEYS[e.emotion];
            return (
              <span key={e.emotion} className="text-[9px] bg-slate-700/70 rounded px-1.5 py-0.5 text-slate-300">
                {EMOTION_EMOJI[e.emotion] ?? ''} {emotionKey ? t(emotionKey) : e.emotion} {pct(e.score)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Body Card ─────────────────────────────────────────────────────────────

const BodyCard: FC<{ body: BodyResult; index: number }> = ({ body, index }) => {
  const { t } = useI18n();

  return (
    <div className="bg-slate-800/60 rounded-xl p-3 border border-slate-700/50 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-white font-bold">🏃 {t('live.body')} {index + 1}</span>
        <span className="text-slate-400">{pct(body.score)}</span>
      </div>
      <ScoreBar score={body.score} color="bg-violet-500" />
      <div className="text-slate-500 text-[10px]">{body.keypointCount} {t('live.keypointsTracked')}</div>
    </div>
  );
};

// ─── Hand Card ─────────────────────────────────────────────────────────────

const HandCard: FC<{ hand: HandResult; index: number }> = ({ hand, index }) => {
  const { t } = useI18n();
  const handedness = hand.handedness.toLowerCase();
  const handednessKey = HAND_TRANSLATION_KEYS[handedness];

  return (
    <div className="bg-slate-800/60 rounded-xl p-3 border border-slate-700/50 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-white font-bold">
          {HAND_EMOJI[handedness] ?? '🖐️'} {handednessKey ? t(handednessKey) : hand.handedness}
        </span>
        <span className="text-slate-400">{pct(hand.score)}</span>
      </div>
      <ScoreBar score={hand.score} color="bg-sky-500" />
      {hand.gestures.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hand.gestures.map((g, i) => (
            <span key={i} className="text-[9px] bg-sky-500/20 text-sky-300 rounded px-1.5 py-0.5">{g}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Object Card ───────────────────────────────────────────────────────────

const ObjectCard: FC<{ obj: ObjectResult }> = ({ obj }) => (
  <div className="flex items-center gap-3 bg-slate-800/60 rounded-xl px-3 py-2 border border-slate-700/50">
    <span className="text-base">📦</span>
    <div className="flex-1 min-w-0 space-y-1">
      <div className="flex justify-between">
        <span className="text-white font-bold capitalize">{obj.label}</span>
        <span className="text-slate-400">{pct(obj.score)}</span>
      </div>
      <ScoreBar score={obj.score} color="bg-orange-500" />
    </div>
  </div>
);

// ─── Human Perception Panel ────────────────────────────────────────────────

const HumanPerceptionPanel: FC<{ detection: VisionDetection | null }> = ({ detection }) => {
  const { t } = useI18n();
  const total = detection
    ? detection.faces.length + detection.bodies.length + detection.hands.length + detection.objects.length
    : 0;

  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
          <span className="text-white font-bold text-sm tracking-wide uppercase">{t('live.perceptionEngine')}</span>
          <span className="text-[10px] font-mono bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-500/30">
            {t('live.statusLive')}
          </span>
        </div>

        {/* Summary badges */}
        <div className="flex items-center gap-2 font-mono text-[11px]">
          {[
            { label: '👤', count: detection?.faces.length ?? 0, color: 'text-emerald-400' },
            { label: '🏃', count: detection?.bodies.length ?? 0, color: 'text-violet-400' },
            { label: '🤚', count: detection?.hands.length ?? 0, color: 'text-sky-400' },
            { label: '📦', count: detection?.objects.length ?? 0, color: 'text-orange-400' },
          ].map(({ label, count, color }) => (
            <div key={label} className="flex items-center gap-1 bg-slate-800 rounded-lg px-2 py-1">
              <span>{label}</span>
              <span className={`font-bold ${color}`}>{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Body */}
      {total === 0 ? (
        <div className="flex items-center justify-center h-28 text-slate-600 font-mono text-[12px] gap-2">
          <span className="animate-pulse">◉</span>
          <span>{t('live.waitingForData')}</span>
        </div>
      ) : (
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-[11px]">
          {detection!.faces.length > 0 && (
            <div className="md:col-span-2 space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                👤 {t('live.faces')} ({detection!.faces.length})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {detection!.faces.map((f, i) => <FaceCard key={i} face={f} index={i} />)}
              </div>
            </div>
          )}

          {detection!.bodies.length > 0 && (
            <div className="space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                🏃 {t('live.bodies')} ({detection!.bodies.length})
              </div>
              {detection!.bodies.map((b, i) => <BodyCard key={i} body={b} index={i} />)}
            </div>
          )}

          {detection!.hands.length > 0 && (
            <div className="space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                🤚 {t('live.hands')} ({detection!.hands.length})
              </div>
              {detection!.hands.map((h, i) => <HandCard key={i} hand={h} index={i} />)}
            </div>
          )}

          {detection!.objects.length > 0 && (
            <div className="md:col-span-2 space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                📦 {t('live.objects')} ({detection!.objects.length})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {detection!.objects.map((o, i) => <ObjectCard key={i} obj={o} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Video Tool Menu ───────────────────────────────────────────────────────

const VideoToolMenu: FC<{ realtime: RealtimeState }> = ({ realtime }) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  return (
    <div className="absolute right-5 top-5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white transition hover:bg-black/80"
        aria-label={t('live.openTools')}
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
            <span>{t('live.realtimeSubtitle')}</span>
            <span className={`h-5 w-9 rounded-full p-0.5 transition ${realtime.subtitleEnabled ? 'bg-emerald-500' : 'bg-slate-700'}`}>
              <span className={`block h-4 w-4 rounded-full bg-white transition ${realtime.subtitleEnabled ? 'translate-x-4' : ''}`}></span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
