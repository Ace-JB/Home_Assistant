// src/config.ts
export const GLOBAL_CONFIG = {
  VIDEO: {
    WIDTH: 480,
    HEIGHT: 360,
    FPS: 15,
    QUALITY: 0.3,
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
    WHISPER_CMD: '../whisper.cpp/build/bin/whisper-cli',
    WHISPER_MODEL: '../whisper.cpp/models/ggml-base.bin',
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
  }
};
