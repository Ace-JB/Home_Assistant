export type TaskTiming = {
    key: string;
    label: string;
    durationMs: number;
    detail?: string;
};

export type CosyVoiceProgressEvent = {
    stageKey: string;
    detail?: string;
    percent?: number;
    timing?: TaskTiming;
};

export type CosyVoiceProgressReporter = (event: CosyVoiceProgressEvent) => void;

export type CosyVoiceExtractResult = {
    audioUrl: string;
    audioPath: string;
    transcript: string;
    fileName: string;
    jobId?: string;
    metadataPath?: string;
    tracePath?: string;
    candidates?: CosyVoiceMaterialCandidate[];
    separation?: {
        inputPath: string;
        outputPath: string;
        provider: 'mdx-net' | 'none';
        model?: string;
        onnxProviders?: string[];
        method: 'mdx-net-onnx' | 'current-flow';
        serviceStarted: boolean;
        cacheHit: boolean;
        durationMs: number;
        fallbackUsed: boolean;
    };
    videoUrl?: string;
    videoPath?: string;
    timings?: TaskTiming[];
};

export type CosyVoiceMaterialCandidate = {
    id: string;
    speaker: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    text: string;
    quality: 'high' | 'medium';
    reasons: string[];
    score: number;
    qualityScore?: {
        score: number;
        duration: number;
        speechRatio: number;
        silenceRatio: number;
        rmsStability: number;
        pitchStability: number;
        energyStability: number;
        estimatedSnr: number;
        emotionStability: number;
    };
    audioPath: string;
    audioUrl: string;
    textPath: string;
    source: 'raw' | 'vocal';
};

export type CosyVoiceExtractOptions = {
    enhanceVocals?: boolean;
    progress?: CosyVoiceProgressReporter;
};

export type YtDlpAudioFormat = {
    formatId: string;
    label: string;
    ext: string;
    resolution: string;
    fps: number | null;
    vcodec: string;
    acodec: string;
    filesize: number | null;
    protocol: string;
    previewUrl: string;
};

export type CosyVoiceSaveInput = {
    provider: 'cosyvoice' | 'say';
    baseUrl: string;
    endpoint: string;
    speakerId?: string;
    speakerName: string;
    promptAudioPath: string;
    promptText: string;
    timeoutMs: number;
    fallbackToSay: boolean;
};

export type CosyVoiceSpeakerProfile = {
    id: string;
    name: string;
    promptAudioPath: string;
    promptText: string;
    promptList?: Array<{
        id: string;
        audioPath: string;
        text: string;
        score?: number;
        createdAt: string;
    }>;
    benchmarkResults?: string[];
    cachedResponses?: string[];
    createdAt: string;
    updatedAt: string;
};

export type YtDlpStatus = {
    installed: boolean;
    bin: string;
    version: string | null;
    error: string | null;
};

export type CosyVoiceServiceStatus = {
    ok: boolean;
    url: string;
    status: number | null;
    error: string | null;
};
