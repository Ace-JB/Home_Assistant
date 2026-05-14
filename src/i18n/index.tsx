import { createContext, useContext, useEffect, useMemo, useState, type FC, type PropsWithChildren } from 'react';

export type Language = 'zh' | 'en';

const LANGUAGE_STORAGE_KEY = 'home-assistant-language';

const translations = {
  zh: {
    'app.title.dashboard': '系统概览',
    'app.title.live': '实时监控',
    'language.label': '语言',
    'language.zh': '中文',
    'language.en': 'English',
    'sidebar.dashboard': '控制面板',
    'sidebar.live': '实时流查看',
    'sidebar.history': '历史记录',
    'sidebar.settings': '系统配置',
    'sidebar.systemOnline': '系统在线',
    'sidebar.ffmpegActive': 'FFMPEG 核心运行中',
    'dashboard.cpuLoad': 'CPU 负载',
    'dashboard.bufferStatus': '缓冲区状态',
    'dashboard.bufferNormal': '正常',
    'dashboard.uptime': '运行时间',
    'dashboard.heartbeat': '感知心跳频率',
    'live.pipelineParams': '管线参数',
    'live.transport': '传输',
    'live.encoder': '编码器',
    'live.aiBackend': 'AI 后端',
    'live.voiceActivity': '语音活动',
    'live.listening': '正在聆听...',
    'live.perceptionEngine': '人类感知引擎',
    'live.statusLive': '实时',
    'live.waitingForData': '等待感知数据...',
    'live.faces': '面部',
    'live.bodies': '身体',
    'live.hands': '手部',
    'live.objects': '物体',
    'live.body': '身体',
    'live.keypointsTracked': '个关键点已追踪',
    'live.similarity': '相似度',
    'live.identified': '已识别',
    'live.unknown': '未知',
    'live.unknownStranger': '未知陌生人',
    'live.realtimeSubtitle': '实时字幕',
    'live.openTools': '打开实时视频工具',
    'emotion.happy': '开心',
    'emotion.sad': '悲伤',
    'emotion.angry': '愤怒',
    'emotion.fear': '恐惧',
    'emotion.disgust': '厌恶',
    'emotion.surprise': '惊讶',
    'emotion.neutral': '平静',
    'hand.left': '左手',
    'hand.right': '右手',
    'hand.unknown': '未知手势',
  },
  en: {
    'app.title.dashboard': 'System Overview',
    'app.title.live': 'Live Monitor',
    'language.label': 'Language',
    'language.zh': '中文',
    'language.en': 'English',
    'sidebar.dashboard': 'Dashboard',
    'sidebar.live': 'Live Stream',
    'sidebar.history': 'History',
    'sidebar.settings': 'System Config',
    'sidebar.systemOnline': 'System Online',
    'sidebar.ffmpegActive': 'FFMPEG Core Active',
    'dashboard.cpuLoad': 'CPU Load',
    'dashboard.bufferStatus': 'Buffer Status',
    'dashboard.bufferNormal': 'Normal',
    'dashboard.uptime': 'Uptime',
    'dashboard.heartbeat': 'Perception Heartbeat',
    'live.pipelineParams': 'Pipeline Params',
    'live.transport': 'Transport',
    'live.encoder': 'Encoder',
    'live.aiBackend': 'AI Backend',
    'live.voiceActivity': 'Voice Activity',
    'live.listening': 'Listening...',
    'live.perceptionEngine': 'Human Perception Engine',
    'live.statusLive': 'Live',
    'live.waitingForData': 'Waiting for perception data...',
    'live.faces': 'Faces',
    'live.bodies': 'Bodies',
    'live.hands': 'Hands',
    'live.objects': 'Objects',
    'live.body': 'Body',
    'live.keypointsTracked': 'keypoints tracked',
    'live.similarity': 'Similarity',
    'live.identified': 'Identified',
    'live.unknown': 'Unknown',
    'live.unknownStranger': 'Unknown Stranger',
    'live.realtimeSubtitle': 'Real-time subtitle',
    'live.openTools': 'Open live video tools',
    'emotion.happy': 'happy',
    'emotion.sad': 'sad',
    'emotion.angry': 'angry',
    'emotion.fear': 'fear',
    'emotion.disgust': 'disgust',
    'emotion.surprise': 'surprise',
    'emotion.neutral': 'neutral',
    'hand.left': 'Left',
    'hand.right': 'Right',
    'hand.unknown': 'Unknown',
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';

  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;

  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const I18nProvider: FC<PropsWithChildren> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage: setLanguageState,
    t: (key) => translations[language][key],
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used inside I18nProvider');
  }
  return context;
}
