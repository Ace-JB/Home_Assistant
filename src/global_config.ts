// src/config.ts
export const GLOBAL_CONFIG = {
  SYNC: {
    WINDOW_SIZE: 60000, // 60s 缓冲区
  },
  VIDEO: {
    WIDTH: 640,
    HEIGHT: 480,
    FPS: "15",
    QUALITY: 0.3,
    DEVICE: "0",
  },
  SERVER: {
    PORT: 3000,
  },
  FACE: {
    DISTANCE_THRESHOLD: 0.6,
    COOLDOWN: 5000, // 5秒内不重复触发同一个人的决策
    PROCESS_HZ: 2,   // 每秒处理 2 次识别 (500ms 间隔)
  },
  VOICE: {
    WAKE_WORD: '管家',
    DEVICE: ':0',
    SAMPLE_RATE: '16000',
    WHISPER_CMD: '../whisper.cpp/build/bin/whisper-cli',
    WHISPER_MODEL: '../whisper.cpp/models/ggml-base.bin',
  },
  FFMPEG: {
    BIN: process.env.FFMPEG_PATH ?? 'ffmpeg',
    STARTUP_TIMEOUT_MS: 10000,
  },
  FRAME_RATE: {
    SILENCE: 5,
    ACTIVE: 30,
    STRONG: 60
  },
  FRAME_QUALITY: {
    SILENCE: 10,
    ACTIVE: 5,
    STRONG: 3
  },
  OLLAMA: {
    IP: "http://[IP_ADDRESS]/api",
  },
  CACHE: {
    MAX_FILE_AGE: 30 * 24 * 60 * 60 * 1000, // 30 天
  },
};
