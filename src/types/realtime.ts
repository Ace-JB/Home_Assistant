import type { VisionProfile } from '../shared/vision/types';

// --- Vision perception types (mirrors face/index.ts server types) ---
export type EmotionScore = { emotion: string; score: number };

export type FaceResult = {
  label: string;
  matched: boolean;
  similarity: number | null;
  candidateLabel: string | null;
  emotions: EmotionScore[];
  box: { x: number; y: number; width: number; height: number };
};

export type BodyResult = {
  score: number;
  keypointCount: number;
  box: { x: number; y: number; width: number; height: number };
};

export type HandResult = {
  score: number;
  handedness: string;
  gestures: string[];
  box: { x: number; y: number; width: number; height: number };
};

export type ObjectResult = {
  label: string;
  score: number;
  box: { x: number; y: number; width: number; height: number };
};

export type VisionDetection = {
  profile: VisionProfile;
  requestedProfile: VisionProfile;
  degraded: boolean;
  degradeReason?: string;
  faces: FaceResult[];
  bodies: BodyResult[];
  hands: HandResult[];
  objects: ObjectResult[];
  ts: number;
};

export type VoiceSessionMode = 'standby' | 'awake' | 'listening' | 'processing' | 'speaking';

// --- Socket message union ---
export type RealtimeMessage =
  | { type: 'socket.connected'; ts: number; clientId: string; clients: number; language: 'zh' | 'en'; voiceSessionMode: VoiceSessionMode }
  | { type: 'socket.status'; ts: number; clients: number; language: 'zh' | 'en'; voiceSessionMode: VoiceSessionMode }
  | { type: 'video.frame'; ts: number; mime: 'image/jpeg'; data: string }
  | { type: 'voice.level'; ts: number; bytes: number; rms: number; peak: number }
  | { type: 'voice.text'; ts: number; text: string; startTs: number; endTs: number }
  | { type: 'voice.session'; ts: number; mode: VoiceSessionMode; reason: string; conversationId?: string | null; pipelineId?: string | null }
  | {
    type: 'vision.detection';
    ts: number;
    profile: VisionProfile;
    requestedProfile: VisionProfile;
    degraded: boolean;
    degradeReason?: string;
    faces: FaceResult[];
    bodies: BodyResult[];
    hands: HandResult[];
    objects: ObjectResult[];
  };

export type BufferedFrame = {
  ts: number;
  src: string;
};

export type SubtitleCue = {
  startTs: number;
  endTs: number;
  text: string;
};

export type TranscriptEntry = {
  startTs: number;
  endTs: number;
  text: string;
  ts: number;
};

export type RealtimeState = {
  connected: boolean;
  clients: number;
  language: 'zh' | 'en';
  frameSrc: string | null;
  audioLevel: number;
  transcript: string;
  transcriptHistory: TranscriptEntry[];
  activeSubtitle: string;
  voiceSessionMode: VoiceSessionMode;
  videoDelayMs: number;
  lastFrameAt: number | null;
  visionDetection: VisionDetection | null;
  setLanguage: (language: 'zh' | 'en') => void;
  setVideoDelay: (delayMs: number) => void;
};
