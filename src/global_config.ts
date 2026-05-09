// src/config.ts
export const GLOBAL_CONFIG = {
  SYNC: {
    WINDOW_SIZE: 60000, // 60s 缓冲区
  },
  VIDEO: {
    WIDTH: 640,
    HEIGHT: 480,
    FPS: "30",
    QUALITY: 0.3,
    DEVICE: "0",
  },
  SERVER: {
    PORT: 3000,
    SOCKET_PORT: 3001,
  },
  FACE: {
    DISTANCE_THRESHOLD: 0.6,
    COOLDOWN: 5000, // 5秒内不重复触发同一个人的决策
    PROCESS_HZ: 2, // 每秒检测频率
  },
  VOICE: {
    WAKE_WORD: '蛋蛋',
    DEVICE: ':0',
    SAMPLE_RATE: '16000',
    FUNASR_CMD: 'python3 src/server/scripts/funasr_service.py',
    FUNASR_MODEL: 'iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
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
    IP: "http://localhost:11434/api",
  },
  CACHE: {
    MAX_FILE_AGE: 30 * 24 * 60 * 60 * 1000, // 30 天
  },
  MODELS: {
    BASE_PATH: "src/server/models",
    METADATA_DIR: 'src/server/models/metadata',
  }
};
