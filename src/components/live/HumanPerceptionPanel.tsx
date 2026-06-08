import type { FC } from 'react';
import type { VisionDetection, FaceResult, BodyResult, HandResult, ObjectResult } from '../../types/realtime';
import { useI18n, type TranslationKey } from '../../i18n';
import { formatScore } from './format';

const EMOTION_EMOJI: Record<string, string> = {
  happy: '😊', sad: '😢', angry: '😠', fear: '😨',
  disgust: '🤢', surprise: '😲', neutral: '😐',
};

const HAND_EMOJI: Record<string, string> = {
  left: '🤚', right: '✋', unknown: '🖐️',
};

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

function pct(v: number) { return formatScore(v); }

function isUnknownStrangerLabel(label: string): boolean {
  return label === '未知陌生人' || label.toLowerCase() === 'unknown stranger';
}

const ScoreBar: FC<{ score: number; color?: string }> = ({ score, color = 'bg-indigo-500' }) => (
  <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
    <div className={`h-full rounded-full transition-all duration-300 ${color}`} style={{ width: pct(score) }} />
  </div>
);

const FaceCard: FC<{ face: FaceResult }> = ({ face }) => {
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

const HandCard: FC<{ hand: HandResult }> = ({ hand }) => {
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

export const HumanPerceptionPanel: FC<{ detection: VisionDetection | null }> = ({ detection }) => {
  const { t } = useI18n();
  const total = detection
    ? detection.faces.length + detection.bodies.length + detection.hands.length + detection.objects.length
    : 0;

  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
          <span className="text-white font-bold text-sm tracking-wide uppercase">{t('live.perceptionEngine')}</span>
          <span className="text-[10px] font-mono bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-500/30">
            {t('live.statusLive')}
          </span>
          {detection && (
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
              detection.degraded
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                : 'bg-slate-800 text-slate-300 border-slate-700'
            }`}>
              {detection.degraded
                ? `${detection.profile} / ${detection.requestedProfile}`
                : detection.profile}
            </span>
          )}
        </div>

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
                {detection!.faces.map((face, index) => <FaceCard key={index} face={face} />)}
              </div>
            </div>
          )}

          {detection!.bodies.length > 0 && (
            <div className="space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                🏃 {t('live.bodies')} ({detection!.bodies.length})
              </div>
              {detection!.bodies.map((body, index) => <BodyCard key={index} body={body} index={index} />)}
            </div>
          )}

          {detection!.hands.length > 0 && (
            <div className="space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                🤚 {t('live.hands')} ({detection!.hands.length})
              </div>
              {detection!.hands.map((hand, index) => <HandCard key={index} hand={hand} />)}
            </div>
          )}

          {detection!.objects.length > 0 && (
            <div className="md:col-span-2 space-y-2">
              <div className="text-slate-500 uppercase text-[10px] tracking-widest">
                📦 {t('live.objects')} ({detection!.objects.length})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {detection!.objects.map((obj, index) => <ObjectCard key={index} obj={obj} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
