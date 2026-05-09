export type RealtimeMessage =
  | { type: 'socket.connected'; ts: number; clientId: string; clients: number; realtimeSubtitleEnabled: boolean }
  | { type: 'socket.status'; ts: number; clients: number; realtimeSubtitleEnabled: boolean }
  | { type: 'video.frame'; ts: number; mime: 'image/jpeg'; data: string }
  | { type: 'voice.level'; ts: number; bytes: number; rms: number; peak: number }
  | { type: 'voice.text'; ts: number; text: string; startTs: number; endTs: number };

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
  frameSrc: string | null;
  audioLevel: number;
  transcript: string;
  activeSubtitle: string;
  subtitleEnabled: boolean;
  videoDelayMs: number;
  lastFrameAt: number | null;
  setRealtimeSubtitle: (enabled: boolean) => void;
  setVideoDelay: (delayMs: number) => void;
};
