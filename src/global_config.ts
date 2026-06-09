import { loadRuntimeEnv } from '@/config/loadEnv';
import { getCosyVoiceModelDir, getModelBasePath, getPythonServicesRoot, getPythonServicesScriptRoot } from '@/server/services/runtime-paths';

loadRuntimeEnv();

const PYTHON_SERVICES_ROOT = getPythonServicesRoot();
const PYTHON_SERVICES_SCRIPT_ROOT = getPythonServicesScriptRoot();
const MODEL_BASE_PATH = getModelBasePath();

export const GLOBAL_CONFIG = {
  // Media sync window shared by camera/audio buffering.
  SYNC: {
    WINDOW_SIZE: 60000, // 60s 缓冲区
  },

  // Local AVFoundation camera capture defaults.
  VIDEO: {
    WIDTH: 640,
    HEIGHT: 480,
    FPS: "30",
    DEVICE: "0",
  },

  // Bun HTTP/WebSocket server ports.
  SERVER: {
    PORT: 3000,
    SOCKET_PORT: 3001,
  },

  // Face detection thresholds and processing cadence.
  FACE: {
    SIMILARITY_THRESHOLD: parseEnvNumber(process.env.SENTINEL_FACE_SIMILARITY_THRESHOLD, 0.6),
    PROCESS_HZ: 2, // 每秒检测频率
  },

  // Vision profile selection controls how much image context is gathered.
  VISION: {
    DEFAULT_PROFILE: (process.env.SENTINEL_VISION_DEFAULT_PROFILE ?? 'identity') as 'identity' | 'perception' | 'full',
    WAKE_PROFILE: (process.env.SENTINEL_VISION_WAKE_PROFILE ?? 'perception') as 'identity' | 'perception' | 'full',
    INTENT_PROFILE: (process.env.SENTINEL_VISION_INTENT_PROFILE ?? 'full') as 'identity' | 'perception' | 'full',
    INTENT_TTL_MS: parseEnvNumber(process.env.SENTINEL_VISION_INTENT_TTL_MS, 10000),
    PROFILE_IDLE_TTL_MS: parseEnvNumber(process.env.SENTINEL_VISION_PROFILE_IDLE_TTL_MS, 180000),
  },

  VOICE: {
    // Wake word and fast acknowledgement behavior.
    WAKE_WORD: process.env.SENTINEL_WAKE_WORD ?? '管家',
    WAKE_ACK_TEXT: process.env.SENTINEL_WAKE_ACK_TEXT ?? '我在呢',
    WAKE_ACK_FAST_REPLY_ENABLED: parseEnvBoolean(process.env.SENTINEL_WAKE_ACK_FAST_REPLY_ENABLED, true),

    // Local AVFoundation microphone capture defaults.
    DEVICE: ':0',
    SAMPLE_RATE: '16000',

    // Managed Python service roots and shared ports.
    PYTHON_SERVICES_ROOT,
    PYTHON_SERVICES_SCRIPT_ROOT,
    PYTHON_SERVICES_DEVICE: process.env.PYTHON_SERVICES_DEVICE ?? 'mps',
    PYTHON_SERVICES_MODE: (process.env.PYTHON_SERVICES_MODE ?? 'http') as 'http',
    FUNASR_PORT: parseEnvNumber(process.env.FUNASR_PORT, 10101),
    COSYVOICE_PORT: parseEnvNumber(process.env.COSYVOICE_PORT, 10102),
    MDX_PORT: parseEnvNumber(process.env.MDX_PORT, 10103),
    VOICE_DATA_ROOT: process.env.VOICE_DATA_ROOT ?? 'data/voice',

    // FunASR service and model selection.
    FUNASR_BASE_URL: process.env.FUNASR_BASE_URL ?? `http://localhost:${process.env.FUNASR_PORT ?? '10101'}`,
    FUNASR_MODEL: 'iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    FUNASR_MATERIAL_MODEL: process.env.FUNASR_MATERIAL_MODEL ?? 'iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    FUNASR_PUNC_MODEL: process.env.FUNASR_PUNC_MODEL ?? 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
    FUNASR_SPK_MODEL: process.env.FUNASR_SPK_MODEL ?? 'iic/speech_campplus_sv_zh-cn_16k-common',

    // Optional vocal enhancement command used by material processing.
    UVR5_CMD: process.env.UVR5_CMD ?? '',

    // MDX vocal separation service. Base URL and device inherit the shared port/device by default.
    SEPARATION_ENABLED: parseEnvBoolean(process.env.VOICE_SEPARATION_ENABLED, true),
    SEPARATION_ALLOW_FALLBACK: parseEnvBoolean(process.env.VOICE_SEPARATION_ALLOW_FALLBACK, false),
    SEPARATION_MODEL: process.env.VOICE_SEPARATION_MODEL ?? 'UVR-MDX-NET-Inst_HQ_3.onnx',
    SEPARATION_MODEL_PROFILE: (process.env.VOICE_SEPARATION_MODEL_PROFILE ?? 'balanced') as 'fast' | 'balanced' | 'quality',
    SEPARATION_MODEL_DIR: process.env.VOICE_SEPARATION_MODEL_DIR ?? `${PYTHON_SERVICES_ROOT}/models_cache/mdx`,
    SEPARATION_BASE_URL: process.env.VOICE_SEPARATION_BASE_URL ?? `http://localhost:${process.env.MDX_PORT ?? '10103'}`,
    SEPARATION_DEVICE: process.env.VOICE_SEPARATION_DEVICE ?? process.env.PYTHON_SERVICES_DEVICE ?? 'mps',
    SEPARATION_ONNX_PROVIDERS: process.env.VOICE_SEPARATION_ONNX_PROVIDERS ?? 'CoreMLExecutionProvider,CPUExecutionProvider',

    // ASR preprocessing and VAD windows.
    ASR_SEPARATION_MODE: (process.env.VOICE_ASR_SEPARATION_MODE ?? 'off') as 'off' | 'auto' | 'preprocess' | 'utterance-mdx',
    ASR_SEPARATION_MAX_MS: parseEnvNumber(process.env.VOICE_ASR_SEPARATION_MAX_MS, 10000),
    VAD_START_FRAMES: parseEnvNumber(process.env.VOICE_VAD_START_FRAMES, 2),
    VAD_END_FRAMES: parseEnvNumber(process.env.VOICE_VAD_END_FRAMES, 4),
    VAD_COOLDOWN_MS: parseEnvNumber(process.env.VOICE_VAD_COOLDOWN_MS, 120),
    WAKE_VAD_THRESHOLD: parseEnvNumber(process.env.VOICE_WAKE_VAD_THRESHOLD, 0.15),
    WAKE_WINDOW_MS: parseEnvNumber(process.env.VOICE_WAKE_WINDOW_MS, 2500),
    WAKE_PROBE_INTERVAL_MS: parseEnvNumber(process.env.VOICE_WAKE_PROBE_INTERVAL_MS, 700),
    WAKE_SESSION_IDLE_MS: parseEnvNumber(process.env.VOICE_WAKE_SESSION_IDLE_MS, 15000),
    WAKE_PREFIX_NOISE_WARN_CHARS: parseEnvNumber(process.env.VOICE_WAKE_PREFIX_NOISE_WARN_CHARS, 12),
    COMMAND_VAD_THRESHOLD: parseEnvNumber(process.env.VOICE_COMMAND_VAD_THRESHOLD, 0.02),
    COMMAND_SOFT_MAX_MS: parseEnvNumber(process.env.VOICE_COMMAND_SOFT_MAX_MS, 8000),
    COMMAND_HARD_MAX_MS: parseEnvNumber(process.env.VOICE_COMMAND_HARD_MAX_MS, 12000),
    SUBTITLE_VAD_THRESHOLD: parseEnvNumber(process.env.VOICE_SUBTITLE_VAD_THRESHOLD, 0.02),
    SUBTITLE_SOFT_MAX_MS: parseEnvNumber(process.env.VOICE_SUBTITLE_SOFT_MAX_MS, 8000),
    SUBTITLE_HARD_MAX_MS: parseEnvNumber(process.env.VOICE_SUBTITLE_HARD_MAX_MS, 12000),

    // TTS provider and CosyVoice inference settings.
    TTS_PROVIDER: (process.env.SENTINEL_TTS_PROVIDER ?? 'cosyvoice') as 'cosyvoice' | 'say',
    COSYVOICE_BASE_URL: process.env.COSYVOICE_BASE_URL ?? `http://localhost:${process.env.COSYVOICE_PORT ?? '10102'}`,
    COSYVOICE_ENDPOINT: process.env.COSYVOICE_ENDPOINT ?? '/inference_zero_shot',
    COSYVOICE_MODEL_DIR: getCosyVoiceModelDir(),
    COSYVOICE_SAMPLE_RATE: parseEnvNumber(process.env.COSYVOICE_SAMPLE_RATE, 24000),
    COSYVOICE_SPEAKER_ID: process.env.COSYVOICE_SPEAKER_ID ?? '',
    COSYVOICE_SPEAKER_NAME: process.env.COSYVOICE_SPEAKER_NAME ?? '',
    COSYVOICE_PROMPT_AUDIO_PATH: process.env.COSYVOICE_PROMPT_AUDIO_PATH ?? '',
    COSYVOICE_PROMPT_TEXT: process.env.COSYVOICE_PROMPT_TEXT ?? '',
    COSYVOICE_TIMEOUT_MS: parseEnvNumber(process.env.COSYVOICE_TIMEOUT_MS, 30000),
    COSYVOICE_FALLBACK_TO_SAY: parseEnvBoolean(process.env.COSYVOICE_FALLBACK_TO_SAY, true),
    COSYVOICE_TTS_MIN_UNITS: parseEnvNumber(process.env.COSYVOICE_TTS_MIN_UNITS, 28),
    COSYVOICE_TTS_MAX_UNITS: parseEnvNumber(process.env.COSYVOICE_TTS_MAX_UNITS, 60),
    COSYVOICE_TTS_CLEANUP_ON_CANCEL: parseEnvBoolean(process.env.COSYVOICE_TTS_CLEANUP_ON_CANCEL, true),

    // Barge-in detection while the assistant is speaking.
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

  // External command-line tools.
  FFMPEG: {
    BIN: process.env.FFMPEG_PATH ?? 'ffmpeg',
    STARTUP_TIMEOUT_MS: 10000,
  },
  YT_DLP: {
    BIN: process.env.YT_DLP_BIN ?? 'data/tools/bin/yt-dlp',
    COOKIES_FROM_BROWSER: process.env.YT_DLP_COOKIES_FROM_BROWSER ?? 'chrome',
  },

  // Local Ollama endpoints, model IDs, generation limits, and trace controls.
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

  // Generated media/cache retention.
  CACHE: {
    MAX_FILE_AGE: 30 * 24 * 60 * 60 * 1000, // 30 天
  },

  // Model asset directories and intention-generation limits.
  MODELS: {
    METADATA_DIR: `${MODEL_BASE_PATH}/metadata`,
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
