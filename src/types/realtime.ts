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
  faces: FaceResult[];
  bodies: BodyResult[];
  hands: HandResult[];
  objects: ObjectResult[];
  ts: number;
};

// --- Socket message union ---
export type RealtimeMessage =
  | { type: 'socket.connected'; ts: number; clientId: string; clients: number; realtimeSubtitleEnabled: boolean; language: 'zh' | 'en' }
  | { type: 'socket.status'; ts: number; clients: number; realtimeSubtitleEnabled: boolean; language: 'zh' | 'en' }
  | { type: 'video.frame'; ts: number; mime: 'image/jpeg'; data: string }
  | { type: 'voice.level'; ts: number; bytes: number; rms: number; peak: number }
  | { type: 'voice.text'; ts: number; text: string; startTs: number; endTs: number }
  | { type: 'vision.detection'; ts: number; faces: FaceResult[]; bodies: BodyResult[]; hands: HandResult[]; objects: ObjectResult[] };

export type BufferedFrame = {
  ts: number;
  src: string;
};

export type SubtitleCue = {
  startTs: number;
  endTs: number;
  text: string;
};

export type RealtimeState = {
  connected: boolean;
  clients: number;
  language: 'zh' | 'en';
  frameSrc: string | null;
  audioLevel: number;
  transcript: string;
  activeSubtitle: string;
  subtitleEnabled: boolean;
  videoDelayMs: number;
  lastFrameAt: number | null;
  visionDetection: VisionDetection | null;
  setRealtimeSubtitle: (enabled: boolean) => void;
  setLanguage: (language: 'zh' | 'en') => void;
  setVideoDelay: (delayMs: number) => void;
};
