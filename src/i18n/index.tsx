import { createContext, useContext, useEffect, useMemo, useState, type FC, type PropsWithChildren } from 'react';

export type Language = 'zh' | 'en';

const LANGUAGE_STORAGE_KEY = 'home-assistant-language';

const translations = {
  zh: {
    'app.title.dashboard': '系统概览',
    'app.title.live': '实时监控',
    'app.title.memory': '记忆库',
    'language.label': '语言',
    'language.zh': '中文',
    'language.en': 'English',
    'sidebar.dashboard': '控制面板',
    'sidebar.live': '实时流查看',
    'sidebar.memory': '记忆库',
    'sidebar.history': '历史记录',
    'sidebar.settings': '系统配置',
    'sidebar.systemOnline': '系统在线',
    'sidebar.ffmpegActive': 'FFMPEG 核心运行中',
    'dashboard.cpuLoad': 'CPU 负载',
    'dashboard.bufferStatus': '缓冲区状态',
    'dashboard.bufferNormal': '正常',
    'dashboard.uptime': '运行时间',
    'dashboard.heartbeat': '感知心跳频率',
    'memory.searchPlaceholder': '搜索会话内容或回复',
    'memory.search': '搜索',
    'memory.from': '开始时间',
    'memory.to': '结束时间',
    'memory.refresh': '刷新',
    'memory.clear': '清空筛选',
    'memory.loading': '正在读取记忆...',
    'memory.empty': '暂无已保存会话',
    'memory.results': '条会话',
    'memory.user': '用户',
    'memory.agent': '助手',
    'memory.createdAt': '创建时间',
    'memory.previous': '上一页',
    'memory.next': '下一页',
    'memory.error': '读取记忆失败',
    'memory.details': '详情',
    'memory.remove': '删除',
    'memory.close': '关闭',
    'memory.prune': '修剪',
    'memory.reprune': '重新修剪',
    'memory.saveApproved': '保存批准记忆',
    'memory.pruning': '正在修剪...',
    'memory.pruneTitle': '会话修剪',
    'memory.pruneHint': '编辑要提供给模型上下文的记忆草稿',
    'memory.pruneInstructionPlaceholder': '可选：告诉模型你希望如何修剪这段记忆，例如“强调我的口味偏好，不要记录一次性闲聊”。',
    'memory.pruneSaved': '已保存到上下文记忆',
    'memory.pruneReady': '修剪草稿已生成，请确认后保存',
    'memory.saving': '保存中...',
    'memory.removeConfirm': '确定删除这条会话吗？',
    'memory.rawTab': '原始会话',
    'memory.prunedTab': '已修剪记忆',
    'memory.noPruned': '暂无已保存的修剪记忆',
    'memory.update': '更新',
    'memory.updated': '已更新',
    'memory.removeMemoryConfirm': '确定删除这条修剪记忆吗？',
    'memory.rawSessions': '原始会话',
    'memory.briefMemories': '摘要记忆',
    'memory.briefSearchPlaceholder': '搜索摘要记忆',
    'memory.sourceConversation': '来源会话',
    'memory.topic': '主题',
    'memory.score': '评分',
    'memory.userState': '用户状态',
    'memory.behaviorSignal': '行为线索',
    'memory.interactionResult': '互动结果',
    'memory.situation': '场景',
    'memory.hitCount': '命中次数',
    'memory.lastAccessed': '最近使用',
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
    'app.title.memory': 'Memory',
    'language.label': 'Language',
    'language.zh': '中文',
    'language.en': 'English',
    'sidebar.dashboard': 'Dashboard',
    'sidebar.live': 'Live Stream',
    'sidebar.memory': 'Memory',
    'sidebar.history': 'History',
    'sidebar.settings': 'System Config',
    'sidebar.systemOnline': 'System Online',
    'sidebar.ffmpegActive': 'FFMPEG Core Active',
    'dashboard.cpuLoad': 'CPU Load',
    'dashboard.bufferStatus': 'Buffer Status',
    'dashboard.bufferNormal': 'Normal',
    'dashboard.uptime': 'Uptime',
    'dashboard.heartbeat': 'Perception Heartbeat',
    'memory.searchPlaceholder': 'Search session or response',
    'memory.search': 'Search',
    'memory.from': 'From',
    'memory.to': 'To',
    'memory.refresh': 'Refresh',
    'memory.clear': 'Clear filters',
    'memory.loading': 'Loading memory...',
    'memory.empty': 'No saved sessions yet',
    'memory.results': 'sessions',
    'memory.user': 'User',
    'memory.agent': 'Agent',
    'memory.createdAt': 'Created at',
    'memory.previous': 'Previous',
    'memory.next': 'Next',
    'memory.error': 'Failed to load memory',
    'memory.details': 'Details',
    'memory.remove': 'Delete',
    'memory.close': 'Close',
    'memory.prune': 'Prune',
    'memory.reprune': 'Re-prune',
    'memory.saveApproved': 'Save approved memory',
    'memory.pruning': 'Pruning...',
    'memory.pruneTitle': 'Session pruning',
    'memory.pruneHint': 'Edit the memory draft that will be supplied to model context',
    'memory.pruneInstructionPlaceholder': 'Optional: tell the model how to prune this memory, e.g. "Emphasize my preferences and skip one-off small talk."',
    'memory.pruneSaved': 'Saved to context memory',
    'memory.pruneReady': 'Pruned draft generated. Review before saving',
    'memory.saving': 'Saving...',
    'memory.removeConfirm': 'Delete this session?',
    'memory.rawTab': 'Raw session',
    'memory.prunedTab': 'Pruned memories',
    'memory.noPruned': 'No saved pruned memories yet',
    'memory.update': 'Update',
    'memory.updated': 'Updated',
    'memory.removeMemoryConfirm': 'Delete this pruned memory?',
    'memory.rawSessions': 'Raw sessions',
    'memory.briefMemories': 'Brief memories',
    'memory.briefSearchPlaceholder': 'Search brief memories',
    'memory.sourceConversation': 'Source session',
    'memory.topic': 'Topic',
    'memory.score': 'Score',
    'memory.userState': 'User state',
    'memory.behaviorSignal': 'Behavior signal',
    'memory.interactionResult': 'Interaction result',
    'memory.situation': 'Situation',
    'memory.hitCount': 'Hits',
    'memory.lastAccessed': 'Last used',
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
