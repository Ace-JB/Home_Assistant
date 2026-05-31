// src/config.ts
import { loadRuntimeEnv } from '@/config/loadEnv';

loadRuntimeEnv();

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
    DEMO_MODE: (process.env.SENTINEL_DEMO_MODE ?? 'full') as 'full' | 'video' | 'audio',
  },
  FACE: {
    DISTANCE_THRESHOLD: 0.6,
    COOLDOWN: 5000, // 5秒内不重复触发同一个人的决策
    PROCESS_HZ: 2, // 每秒检测频率
  },
  VOICE: {
    WAKE_WORD: process.env.SENTINEL_WAKE_WORD ?? '管家',
    DEVICE: ':0',
    SAMPLE_RATE: '16000',
    FUNASR_CMD: process.env.FUNASR_CMD ?? 'python3 src/server/scripts/funasr_service.py',
    FUNASR_MODEL: 'iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    FUNASR_MATERIAL_MODEL: process.env.FUNASR_MATERIAL_MODEL ?? 'iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    FUNASR_PUNC_MODEL: process.env.FUNASR_PUNC_MODEL ?? 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
    FUNASR_SPK_MODEL: process.env.FUNASR_SPK_MODEL ?? 'iic/speech_campplus_sv_zh-cn_16k-common',
    UVR5_CMD: process.env.UVR5_CMD ?? '',
    TTS_PROVIDER: (process.env.SENTINEL_TTS_PROVIDER ?? 'cosyvoice') as 'cosyvoice' | 'say',
    COSYVOICE_BASE_URL: process.env.COSYVOICE_BASE_URL ?? 'http://localhost:50000',
    COSYVOICE_ENDPOINT: process.env.COSYVOICE_ENDPOINT ?? '/inference_zero_shot',
    COSYVOICE_INSTALL_DIR: process.env.COSYVOICE_INSTALL_DIR ?? 'src/server/models/voice/CosyVoice3-MLX',
    COSYVOICE_CONDA_ENV: process.env.COSYVOICE_CONDA_ENV ?? 'cosyvoice',
    COSYVOICE_MODEL_DIR: process.env.COSYVOICE_MODEL_DIR ?? 'mlx-community/Fun-CosyVoice3-0.5B-2512-4bit',
    COSYVOICE_MLX_PACKAGE: process.env.COSYVOICE_MLX_PACKAGE ?? 'mlx-audio-plus==0.1.8',
    COSYVOICE_SAMPLE_RATE: parseEnvNumber(process.env.COSYVOICE_SAMPLE_RATE, 24000),
    COSYVOICE_SPEAKER_ID: process.env.COSYVOICE_SPEAKER_ID ?? '',
    COSYVOICE_SPEAKER_NAME: process.env.COSYVOICE_SPEAKER_NAME ?? '',
    COSYVOICE_PROMPT_AUDIO_PATH: process.env.COSYVOICE_PROMPT_AUDIO_PATH ?? '',
    COSYVOICE_PROMPT_TEXT: process.env.COSYVOICE_PROMPT_TEXT ?? '',
    COSYVOICE_TIMEOUT_MS: parseEnvNumber(process.env.COSYVOICE_TIMEOUT_MS, 30000),
    COSYVOICE_FALLBACK_TO_SAY: parseEnvBoolean(process.env.COSYVOICE_FALLBACK_TO_SAY, true),
    BARGE_IN_ENABLED: true,
    BARGE_IN_VAD_THRESHOLD: 0.08,
    BARGE_IN_MIN_DURATION_MS: 420,
    BARGE_IN_KEYWORD_MIN_DURATION_MS: 220,
    BARGE_IN_GUARD_MS: 350,
    BARGE_IN_PROBE_INTERVAL_MS: 650,
    BARGE_IN_SILENCE_END_MS: 180,
    BARGE_IN_MAX_BUFFER_MS: 1300,
    BARGE_IN_ECHO_SIMILARITY: 0.65,
    BARGE_IN_KEYWORDS: [
      '停',
      '停一下',
      '停下',
      '停一停',
      '停止',
      '别说了',
      '不要说了',
      '别讲了',
      '别念了',
      '先别说',
      '打住',
      '暂停',
      '等一下',
      '等下',
      '等会',
      '等一会',
      '等等',
      '闭嘴',
      '安静',
      '算了',
      '不是',
      '不对',
      '错了',
      '我说错了',
      '重新来',
      'stop',
      'wait',
      'pause',
      'hold on',
      'wrong',
      'cancel',
    ],
  },
  FFMPEG: {
    BIN: process.env.FFMPEG_PATH ?? 'ffmpeg',
    STARTUP_TIMEOUT_MS: 10000,
  },
  YT_DLP: {
    BIN: process.env.YT_DLP_BIN ?? 'yt-dlp',
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
    TEXT_MODEL: "qwen2.5:7b",
    INTENTION_MODEL: process.env.SENTINEL_INTENTION_MODEL ?? process.env.SENTINEL_INTENT_MODEL,
    VISION_MODEL: "qwen2.5vl:7b",
    TRACE_ENABLED: parseEnvBoolean(process.env.SENTINEL_MODEL_TRACE, false),
    TRACE_MAX_CHARS: parseEnvNumber(process.env.SENTINEL_MODEL_TRACE_MAX_CHARS, 4000),
    TEXT_NUM_CTX: 8192,
    TEXT_MAX_TOKENS: 512,
    TEXT_TEMPERATURE: 0.2,
    TEXT_TOP_P: 0.9,
    VISION_NUM_CTX: 4096,
    VISION_MAX_TOKENS: 256,
    VISION_TEMPERATURE: 0.1,
  },
  CACHE: {
    MAX_FILE_AGE: 30 * 24 * 60 * 60 * 1000, // 30 天
  },
  MODELS: {
    BASE_PATH: "src/server/models",
    METADATA_DIR: 'src/server/models/metadata',
    INTENSION: {
      MAX_TOKENS: 900,
    }
  }
};

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
