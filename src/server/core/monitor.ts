import { GLOBAL_CONFIG } from '@/global_config';
import { initCamera } from "@tools/Camera";
import {
    extractTextFromVoiceStream,
    extractSpeechReadyChunk,
    initAudioListen,
    isEchoLikeTranscript,
    isValidBargeInTranscript,
    isWakeAckAudioCached,
    playWakeAckInterruptible,
    prewarmWakeAckAudio,
    speakInterruptible,
    validateTextToSpeechConfig,
    type InterruptibleSpeech,
} from "@tools/Voice";
import { realtimeSocket, startRealtimeSocketServer, calculatePcmLevel } from "@tools/Socket";

import Pipe2Jpeg from 'pipe2jpeg';
import { syncManager } from '@modules/media';
import { faceEngine, type HumanDetectionResult } from '@modules/media/face';
import { memory } from '@modules/memory';
import { faceValue } from '@tools/WiseRelex';
import type { BrainCommandResult, CameraRecognitionContext } from '@server/modules/brain';
import type { ConversationMessage } from '@modules/memory';
import { pipelineLogs } from '@server/services/PipelineLogService';
import { AudioSegmenter, type AudioSegment } from '@server/services/audio/AudioSegmenter';
import {
    visionAttention,
} from '@server/modules/vision/attention';
import type { VisionProfile } from '@/shared/vision/types';
import {
    extractWakeCommand,
    hasMeaningfulWakeCommand,
    hasWakeWordInText,
    normalizeWakeText,
} from '@server/services/audio/wakeText';

const ASR_VAD_DIAGNOSTIC_INTERVAL_MS = 10_000;
const ASR_DEDUPE_CACHE_TTL_MS = 20_000;
const ASR_DEDUPE_MIN_OVERLAP = 0.95;
const ASR_DEDUPE_MAX_ENTRIES = 8;
const VISION_PROFILE_CLEANUP_INTERVAL_MS = 30_000;
const VISION_PROFILE_IDLE_MIN_MS = 60_000;
const VISION_PROFILE_IDLE_MAX_MS = 300_000;

type AsrCacheReason = 'wake' | 'command' | 'subtitle' | 'barge-in';
type AsrCacheEntry = {
    reason: AsrCacheReason;
    startTs: number;
    endTs: number;
    audioBytes: number;
    hash: number;
    text: string;
    createdAt: number;
};
type AsrLogOptions = Parameters<typeof extractTextFromVoiceStream>[1];

let firstAudioReceived = false;
type MonitorMode = 'full' | 'video' | 'audio';
type MonitorStop = () => Promise<void>;
type MonitorRuntime = {
    mode: MonitorMode;
    stop: MonitorStop;
    startedAt: number;
};
type MonitorRuntimeState = {
    runtime?: MonitorRuntime;
    starting?: Promise<MonitorRuntime>;
};

const MONITOR_RUNTIME_KEY = Symbol.for('home-assistant.monitorRuntime');

function getMonitorRuntimeState(): MonitorRuntimeState {
    const globalScope = globalThis as typeof globalThis & { [MONITOR_RUNTIME_KEY]?: MonitorRuntimeState };
    if (!globalScope[MONITOR_RUNTIME_KEY]) {
        globalScope[MONITOR_RUNTIME_KEY] = {};
    }
    return globalScope[MONITOR_RUNTIME_KEY]!;
}

function buildCameraRecognitionContext(detection: HumanDetectionResult): CameraRecognitionContext {
    const { faces, bodies, hands, objects, ts } = detection;
    const recognizedLabels = [...new Set(
        faces
            .filter(face => face.matched)
            .map(face => face.label)
    )];
    const bestFace = [...faces].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))[0];
    const verifiedFace = faces.find(face => face.matched);

    return {
        ts,
        profile: detection.profile,
        requestedProfile: detection.requestedProfile,
        degraded: detection.degraded,
        degradeReason: detection.degradeReason,
        faces,
        recognizedLabels,
        hasStranger: faces.some(face => face.label === '未知陌生人'),
        identityVerification: verifiedFace
            ? {
                verified: true,
                label: verifiedFace.label,
                reason: 'recognized_face',
                bestCandidate: verifiedFace.candidateLabel,
                similarity: verifiedFace.similarity,
                threshold: verifiedFace.threshold,
            }
            : {
                verified: false,
                label: null,
                reason: faces.length === 0 ? 'no_face' : bestFace?.candidateLabel ? 'possible_face_match' : 'unknown_face',
                bestCandidate: bestFace?.candidateLabel ?? null,
                similarity: bestFace?.similarity ?? null,
                threshold: bestFace?.threshold,
        },
        confidence: 'fresh',
        bodies: bodies.map(body => ({
            score: body.score,
            keypointCount: body.keypointCount,
        })),
        hands: hands.map(hand => ({
            score: hand.score,
            handedness: hand.handedness,
            gestures: hand.gestures,
        })),
        objects: objects.map(object => ({
            label: object.label,
            score: object.score,
        })),
    };
}

function markRecognitionAge(context: CameraRecognitionContext | null): CameraRecognitionContext | undefined {
    if (!context) {
        return undefined;
    }

    const ageMs = Date.now() - context.ts;
    const confidence = ageMs > 5_000 ? 'stale' : 'fresh';
    return {
        ...context,
        ageMs,
        confidence,
        identityVerification: confidence === 'stale'
            ? {
                ...context.identityVerification,
                verified: false,
                label: null,
                reason: 'stale',
            }
            : context.identityVerification,
    };
}

function shouldGenerateMemoryCandidate(messages: ConversationMessage[]): boolean {
    const userMessages = messages.filter(message => message.role === 'user' && message.content.trim().length > 1);
    const agentMessages = messages.filter(message => message.role === 'agent' && message.content.trim().length > 0);
    return userMessages.length >= 2 && agentMessages.length >= 2 && messages.length >= 4;
}

function extractMemoryCandidateScore(draft: string): number {
    const parsed = parseJsonLike(draft);
    const retention = objectValue(parsed)?.retention_evaluation;
    const score = numberValue(objectValue(retention)?.recommendation_score)
        ?? numberValue(objectValue(parsed)?.base_score)
        ?? numberValue(objectValue(parsed)?.baseScore);
    return Number.isFinite(score) ? Math.max(1, Math.min(5, Math.round(score!))) : 3;
}

function parseJsonLike(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        const match = value.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
}

function requestWakeVisionAttention(reason: string): void {
    visionAttention.request({
        id: 'wake-session',
        source: 'wake',
        profile: GLOBAL_CONFIG.VISION.WAKE_PROFILE,
        priority: 20,
        reason,
        ttlMs: GLOBAL_CONFIG.VOICE.WAKE_SESSION_IDLE_MS,
    });
    faceEngine.prewarm(GLOBAL_CONFIG.VISION.WAKE_PROFILE);
}

function getVisionProfileIdleTtlMs(): number {
    return Math.min(
        VISION_PROFILE_IDLE_MAX_MS,
        Math.max(VISION_PROFILE_IDLE_MIN_MS, GLOBAL_CONFIG.VISION.PROFILE_IDLE_TTL_MS),
    );
}

function cleanupIdleVisionProfiles(reason: string): void {
    const now = Date.now();
    const attention = visionAttention.snapshot(now);
    if (attention.idleSince === null || attention.idleMs < getVisionProfileIdleTtlMs()) {
        return;
    }

    for (const result of faceEngine.cleanupIdleProfiles({
        now,
        idleTtlMs: getVisionProfileIdleTtlMs(),
        activeProfile: attention.activeProfile,
        hasActiveRequest: attention.hasActiveRequest,
    })) {
        if (result.action !== 'released' && result.reason !== 'release_failed') {
            continue;
        }
        pipelineLogs.append({
            category: 'vision',
            level: result.action === 'released' ? 'info' : 'warn',
            title: result.action === 'released' ? 'vision.profile.unloaded' : 'vision.profile.unload_failed',
            message: result.action === 'released'
                ? `Vision profile unloaded: ${result.profile}`
                : `Vision profile unload failed: ${result.profile}`,
            metadata: {
                profile: result.profile,
                idleMs: result.idleMs,
                reason,
                releaseMode: result.releaseMode,
                error: result.error,
            },
            pipelineId: 'vision-attention',
        });
    }
}

async function detectVisionFrame(
    jpegBuffer: Buffer,
    onDetection: (detection: HumanDetectionResult) => void,
): Promise<void> {
    const attention = visionAttention.resolve();
    const requestedProfile = attention.activeProfile as VisionProfile;
    const detection = await faceEngine.detect(jpegBuffer, requestedProfile, { allowDegraded: true });

    if (detection.degraded) {
        pipelineLogs.append({
            category: 'vision',
            level: 'debug',
            title: 'vision.detection.degraded',
            message: `Vision detection degraded ${detection.requestedProfile} -> ${detection.profile}`,
            metadata: {
                requestedProfile: detection.requestedProfile,
                profile: detection.profile,
                degradeReason: detection.degradeReason,
                activeReason: attention.activeReason,
            },
            pipelineId: 'vision-attention',
        });
    }

    onDetection(detection);
    realtimeSocket.publishVisionDetection(detection);
}

async function monitor(options: { video: boolean } = { video: true }): Promise<MonitorStop> {
    const startupStartedAt = Date.now();
    startRealtimeSocketServer();
    await validateTextToSpeechConfig().catch((error) => {
        console.warn('[TTS] config validation failed; monitor will continue without blocking camera/audio startup:', error);
    });

    const includeVideo = options.video;
    const { stream: audio, stop: stopAudio } = await initAudioListen();
    const videoRuntime = includeVideo ? await initCamera() : null;
    pipelineLogs.append({
        category: 'system',
        level: 'info',
        title: 'system.ready',
        message: 'Monitor media streams are ready.',
        timings: [{ key: 'monitor_media_startup', label: 'Monitor media startup', durationMs: Date.now() - startupStartedAt }],
        metadata: {
            mode: includeVideo ? 'full' : 'audio',
            camera: includeVideo,
            audio: true,
        },
        pipelineId: 'system',
    });

    const p2j = includeVideo ? new Pipe2Jpeg() : null;
    if (videoRuntime && p2j) {
        videoRuntime.stream.pipe(p2j);
    }

    const wakeSegmenter = new AudioSegmenter({
        speechThreshold: GLOBAL_CONFIG.VOICE.WAKE_VAD_THRESHOLD,
        startFrames: GLOBAL_CONFIG.VOICE.VAD_START_FRAMES,
        endFrames: GLOBAL_CONFIG.VOICE.VAD_END_FRAMES,
        softMaxDurationMs: GLOBAL_CONFIG.VOICE.WAKE_WINDOW_MS,
        hardMaxDurationMs: GLOBAL_CONFIG.VOICE.WAKE_WINDOW_MS,
        cooldownMs: GLOBAL_CONFIG.VOICE.VAD_COOLDOWN_MS,
    });
    const commandSegmenter = new AudioSegmenter({
        speechThreshold: GLOBAL_CONFIG.VOICE.COMMAND_VAD_THRESHOLD,
        startFrames: GLOBAL_CONFIG.VOICE.VAD_START_FRAMES,
        endFrames: GLOBAL_CONFIG.VOICE.VAD_END_FRAMES,
        softMaxDurationMs: GLOBAL_CONFIG.VOICE.COMMAND_SOFT_MAX_MS,
        hardMaxDurationMs: GLOBAL_CONFIG.VOICE.COMMAND_HARD_MAX_MS,
        cooldownMs: GLOBAL_CONFIG.VOICE.VAD_COOLDOWN_MS,
    });
    const subtitleSegmenter = new AudioSegmenter({
        speechThreshold: GLOBAL_CONFIG.VOICE.SUBTITLE_VAD_THRESHOLD,
        startFrames: GLOBAL_CONFIG.VOICE.VAD_START_FRAMES,
        endFrames: GLOBAL_CONFIG.VOICE.VAD_END_FRAMES,
        softMaxDurationMs: GLOBAL_CONFIG.VOICE.SUBTITLE_SOFT_MAX_MS,
        hardMaxDurationMs: GLOBAL_CONFIG.VOICE.SUBTITLE_HARD_MAX_MS,
        cooldownMs: GLOBAL_CONFIG.VOICE.VAD_COOLDOWN_MS,
    });
    let systemSpeaking = false; // 新增：系统是否正在说话
    let subtitleTranscribing = false;
    let wakeTranscribing = false;
    let commandTranscribing = false;
    let wakeWindowFrames: Array<{ data: Buffer; ts: number; peak: number; rms: number; active: boolean }> = [];
    let lastWakeProbeAt = 0;
    let isAwake = false;
    let currentConversationId: string | null = null;
    let currentConversationPipelineId: string | null = null;
    let currentConversationPipelineStartedAt = 0;
    let wakeTimer: any = null;
    let latestCameraRecognition: CameraRecognitionContext | null = null;
    let latestVisionFrame: Buffer | null = null;
    let faceRecognitionRunning = false;
    const visionProfileCleanupTimer = includeVideo
        ? setInterval(() => cleanupIdleVisionProfiles('monitor_interval'), VISION_PROFILE_CLEANUP_INTERVAL_MS)
        : null;
    let activeSpeech: InterruptibleSpeech | null = null;
    let activeSpeechText = '';
    let activeSpeechStartedAt = 0;
    let activeSpeechToken = 0;
    let bargeInBuffer: Buffer[] = [];
    let bargeInStartedAt = 0;
    let bargeInLastActiveTs = 0;
    let bargeInTranscribing = false;
    let bargeInPeak = 0;
    let bargeInLastProbeTs = 0;
    let activeSpeechQueueCancelled = false;
    let activeSpeechQueueCancel: (() => void) | null = null;
    let lastAsrVadDiagnosticAt = 0;
    const asrCache: AsrCacheEntry[] = [];

    function prewarmWakeAckInBackground(reason: string): void {
        const startedAt = Date.now();
        void isWakeAckAudioCached()
            .then((cached) => {
                if (cached) {
                    pipelineLogs.append({
                        category: 'voice-tts',
                        level: 'debug',
                        title: 'wake_ack.prewarm',
                        message: 'Wake acknowledgement audio already cached.',
                        timings: [{ key: 'wake_ack_prewarm', label: '唤醒应答预热', durationMs: Date.now() - startedAt }],
                        metadata: {
                            reason,
                            cached: true,
                        },
                        pipelineId: 'wake-ack',
                    });
                    return null;
                }
                return prewarmWakeAckAudio();
            })
            .catch((error) => {
                console.warn('[TTS] wake ack prewarm failed:', error);
            });
    }

    function resetBargeInBuffer(): void {
        bargeInBuffer = [];
        bargeInStartedAt = 0;
        bargeInLastActiveTs = 0;
        bargeInPeak = 0;
        bargeInLastProbeTs = 0;
    }

    function logAsrVadDiagnostic(reason: string, peak: number): void {
        const now = Date.now();
        if (now - lastAsrVadDiagnosticAt < ASR_VAD_DIAGNOSTIC_INTERVAL_MS) return;
        lastAsrVadDiagnosticAt = now;
        if (GLOBAL_CONFIG.OLLAMA.TRACE_ENABLED) {
            console.debug('[ASR:VAD] waiting', {
                reason,
                peak: Number(peak.toFixed(4)),
                threshold: GLOBAL_CONFIG.VOICE.SUBTITLE_VAD_THRESHOLD,
                wakeState: wakeSegmenter.getState(),
                commandState: commandSegmenter.getState(),
                subtitleState: subtitleSegmenter.getState(),
                subtitleBufferedChunks: subtitleSegmenter.getBufferedFrameCount(),
                systemSpeaking,
            });
        }
    }

    function ensureCurrentConversationId(): string {
        if (!currentConversationId) {
            currentConversationId = memory.createConversationSession().conversationId;
            console.log(`🧠 新会话记忆已创建: ${currentConversationId}`);
        }
        return currentConversationId!;
    }

    function ensureCurrentConversationPipelineId(conversationId: string, startedAt = Date.now()): string {
        if (!currentConversationPipelineId) {
            currentConversationPipelineStartedAt = startedAt;
            currentConversationPipelineId = `conv-${conversationId}-${startedAt}`;
            pipelineLogs.startPipeline({
                id: currentConversationPipelineId,
                kind: 'conversation',
                title: 'Conversation pipeline',
                conversationId,
                startedAt,
                metadata: {
                    conversationId,
                    conversation_id: conversationId,
                    startedBy: 'wake_session',
                },
            });
        }
        return currentConversationPipelineId;
    }

    function completeCurrentConversationPipeline(reason: string): void {
        if (!currentConversationPipelineId) return;
        pipelineLogs.completePipeline(currentConversationPipelineId, {
            status: 'completed',
            metadata: {
                conversationId: currentConversationId,
                reason,
            },
        });
        currentConversationPipelineId = null;
        currentConversationPipelineStartedAt = 0;
    }

    function clearWakeSessionTimeout(): void {
        if (!wakeTimer) return;
        clearTimeout(wakeTimer);
        wakeTimer = null;
    }

    function refreshWakeSessionTimeout(reason: string): void {
        if (!isAwake) return;
        clearWakeSessionTimeout();
        wakeTimer = setTimeout(() => {
            queueMemoryCandidateForSession(currentConversationId);
            realtimeSocket.publishVoiceSession({
                mode: 'standby',
                reason,
                conversationId: currentConversationId,
                pipelineId: currentConversationPipelineId,
            });
            completeCurrentConversationPipeline(reason);
            visionAttention.clearSource('wake');
            isAwake = false;
            currentConversationId = null;
            commandSegmenter.reset('manual_reset');
            wakeWindowFrames = [];
            console.log(`💤 ${reason}，回到待机状态`);
        }, GLOBAL_CONFIG.VOICE.WAKE_SESSION_IDLE_MS);
    }

    function listenAfterInterruption(): void {
        isAwake = true;
        requestWakeVisionAttention('barge_in_interruption');
        wakeSegmenter.reset('manual_reset');
        commandSegmenter.reset('manual_reset');
        subtitleSegmenter.reset('manual_reset');
        realtimeSocket.publishVoiceSession({
            mode: 'listening',
            reason: 'barge_in_interruption',
            conversationId: currentConversationId,
            pipelineId: currentConversationPipelineId,
        });
        refreshWakeSessionTimeout('打断后监听超时');
    }

    function endCurrentSession(reason: string): void {
        queueMemoryCandidateForSession(currentConversationId);
        realtimeSocket.publishVoiceSession({
            mode: 'standby',
            reason,
            conversationId: currentConversationId,
            pipelineId: currentConversationPipelineId,
        });
        completeCurrentConversationPipeline(reason);
        visionAttention.clearSource('wake');
        isAwake = false;
        currentConversationId = null;
        clearWakeSessionTimeout();
        console.log(`💤 ${reason}`);
    }

    function queueMemoryCandidateForSession(conversationId: string | null): void {
        if (!conversationId) return;
        void generateMemoryCandidateForSession(conversationId);
    }

    async function generateMemoryCandidateForSession(conversationId: string): Promise<void> {
        try {
            memory.maintainMemoryLifecycle();
            const conversation = memory.getConversationSession(conversationId);
            if (!conversation || !shouldGenerateMemoryCandidate(conversation.messages)) {
                return;
            }
            const existing = memory.searchMemoryCandidates({ sourceConversationId: conversationId, limit: 1 })[0];
            if (existing) {
                return;
            }

            const { pruneConversationForMemory } = await import('@server/modules/brain');
            const draft = await pruneConversationForMemory(
                conversation.messages,
                realtimeSocket.getAssistantLanguage(),
            );
            const score = extractMemoryCandidateScore(draft);
            memory.saveMemoryCandidate({
                source_conversation_id: conversationId,
                draft_json: draft,
                score,
            });
            console.log(`[Memory] Candidate generated for conversation=${conversationId} score=${score}`);
        } catch (error) {
            console.error('[Memory] Candidate generation failed:', error);
        }
    }

    async function handleCommand(
        command: string,
        deps: { onTextDelta?: (delta: string) => void | Promise<void>; pipelineId?: string } = {},
    ): Promise<BrainCommandResult | null> {
        const trimmed = command.trim();
        if (trimmed.length <= 1) return null;

        console.log(`🧠 正在执行指令: "${trimmed}"`);
        const { brain } = await import('@server/modules/brain');

        const result = await brain.processCommandDetailed(
            trimmed,
            "主人",
            markRecognitionAge(latestCameraRecognition),
            realtimeSocket.getAssistantLanguage(),
            latestVisionFrame ?? undefined,
            currentConversationId ?? undefined,
            deps,
        );
        console.log(`🤖 AI 响应: ${result.text || '[no response]'}`);
        if (result.shouldEndSession && !result.shouldRespond) {
            endCurrentSession('用户结束或无有效对话，回到待机状态');
            return result;
        }
        if (!result.shouldRemember) {
            return result;
        }
        const conversationId = ensureCurrentConversationId();
        memory.appendConversationTurn({
            conversation_id: conversationId,
            user_content: trimmed,
            agent_content: result.text,
        });

        return result;
    }

    function enqueueSpeechChunks(
        getToken: () => number,
        onDone: (speech: InterruptibleSpeech | null) => void,
        speechOptions: { conversationId?: string; logGroupId?: string } = {},
    ): {
        pushDelta: (delta: string) => Promise<void>;
        flush: () => Promise<void>;
        cancel: () => void;
    } {
        let buffer = '';
        let tail = Promise.resolve();
        let cancelled = false;
        const speechToken = getToken();
        const prewarmCosyVoice = GLOBAL_CONFIG.VOICE.TTS_PROVIDER === 'cosyvoice';
        const pending: Array<{ text: string; speech?: InterruptibleSpeech }> = [];

        const pump = async () => {
            while (pending.length > 0) {
                if (cancelled || activeSpeechQueueCancelled || activeSpeechToken !== speechToken) return;
                const item = pending.shift()!;
                const speech = item.speech ?? speakInterruptible(item.text, speechOptions);
                activeSpeech = speech;
                activeSpeechText = item.text;
                activeSpeechStartedAt = Date.now();
                resetBargeInBuffer();
                onDone(speech);
                try {
                    await speech.done;
                } finally {
                    if (activeSpeech === speech) {
                        activeSpeech = null;
                        activeSpeechText = '';
                        activeSpeechStartedAt = 0;
                        resetBargeInBuffer();
                    }
                    onDone(null);
                }
            }
        };

        const enqueue = (text: string) => {
            const chunk = text.trim();
            if (!chunk || cancelled) return;
            console.log(`[TTS:Queue] enqueue chars=${chunk.length} text="${chunk.slice(0, 80)}${chunk.length > 80 ? '...' : ''}"`);
            pending.push({
                text: chunk,
                speech: prewarmCosyVoice ? speakInterruptible(chunk, speechOptions) : undefined,
            });
            tail = tail.then(pump);
        };

        return {
            pushDelta: async (delta: string) => {
                if (cancelled || activeSpeechToken !== speechToken) return;
                buffer += delta;
                let next = extractSpeechReadyChunk(buffer);
                while (next) {
                    buffer = next.rest;
                    enqueue(next.chunk);
                    next = extractSpeechReadyChunk(buffer);
                }
            },
            flush: async () => {
                if (cancelled || activeSpeechQueueCancelled || activeSpeechToken !== speechToken) return;
                const rest = buffer.trim();
                buffer = '';
                enqueue(rest);
                await tail;
            },
            cancel: () => {
                cancelled = true;
                buffer = '';
                for (const item of pending.splice(0)) {
                    item.speech?.stop();
                }
            },
        };
    }

    async function speakResponse(response: string): Promise<void> {
        const speechToken = activeSpeechToken + 1;
        activeSpeechToken = speechToken;
        activeSpeechQueueCancelled = false;
        systemSpeaking = true;
        realtimeSocket.publishVoiceSession({
            mode: 'speaking',
            reason: 'assistant_response_started',
            conversationId: currentConversationId,
            pipelineId: currentConversationPipelineId,
        });
        activeSpeechText = '';
        activeSpeechStartedAt = Date.now();
        resetBargeInBuffer();

        const speechQueue = enqueueSpeechChunks(
            () => speechToken,
            (speech) => {
                if (activeSpeechToken === speechToken) {
                    activeSpeech = speech;
                }
            },
            {
                conversationId: currentConversationId ?? undefined,
                logGroupId: currentConversationPipelineId ?? currentConversationId ?? `response-${speechToken}`,
            },
        );
        activeSpeechQueueCancel = speechQueue.cancel;

        try {
            activeSpeechText = response;
            await speechQueue.pushDelta(response);
            await speechQueue.flush();
        } finally {
            if (activeSpeechQueueCancelled) {
                speechQueue.cancel();
            }
            if (activeSpeechToken === speechToken) {
                activeSpeech = null;
                activeSpeechText = '';
                activeSpeechStartedAt = 0;
                systemSpeaking = false;
                activeSpeechQueueCancel = null;
                resetBargeInBuffer();
                realtimeSocket.publishVoiceSession({
                    mode: isAwake ? 'listening' : 'standby',
                    reason: 'assistant_response_finished',
                    conversationId: currentConversationId,
                    pipelineId: currentConversationPipelineId,
                });
            }
            await new Promise(r => setTimeout(r, 800));

            if (activeSpeechToken !== speechToken) {
                speechQueue.cancel();
                return;
            }
            refreshWakeSessionTimeout('会话超时');
        }
    }

    async function speakWakeAck(): Promise<void> {
        const startedAt = Date.now();
        const speechToken = activeSpeechToken + 1;
        activeSpeechToken = speechToken;
        systemSpeaking = true;
        realtimeSocket.publishVoiceSession({
            mode: 'speaking',
            reason: 'wake_ack_started',
            conversationId: currentConversationId,
            pipelineId: currentConversationPipelineId,
        });
        activeSpeechText = GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT;
        activeSpeechStartedAt = Date.now();
        resetBargeInBuffer();
        const conversationId = currentConversationId ?? undefined;
        const pipelineId = currentConversationPipelineId ?? conversationId;
        activeSpeech = playWakeAckInterruptible();
        try {
            await activeSpeech.done;
            pipelineLogs.append({
                category: 'voice-tts',
                level: 'info',
                title: 'wake_ack.completed',
                message: 'Wake acknowledgement finished.',
                timings: [{ key: 'wake_ack_total', label: '唤醒应答总耗时', durationMs: Date.now() - startedAt }],
                metadata: {
                    conversationId: conversationId ?? null,
                    conversation_id: conversationId ?? null,
                    provider: GLOBAL_CONFIG.VOICE.TTS_PROVIDER,
                    text: GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT,
                },
                conversationId,
                pipelineId,
            });
        } catch (error) {
            console.warn('[TTS] wake ack playback failed:', error);
            pipelineLogs.append({
                category: 'voice-tts',
                level: 'error',
                title: 'wake_ack.failed',
                message: error instanceof Error ? error.message : String(error),
                timings: [{ key: 'wake_ack_total', label: '唤醒应答总耗时', durationMs: Date.now() - startedAt }],
                metadata: {
                    conversationId: conversationId ?? null,
                    conversation_id: conversationId ?? null,
                    provider: GLOBAL_CONFIG.VOICE.TTS_PROVIDER,
                    text: GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT,
                },
                conversationId,
                pipelineId,
            });
        } finally {
            if (activeSpeechToken === speechToken) {
                activeSpeech = null;
                activeSpeechText = '';
                activeSpeechStartedAt = 0;
                systemSpeaking = false;
                resetBargeInBuffer();
                realtimeSocket.publishVoiceSession({
                    mode: isAwake ? 'listening' : 'standby',
                    reason: 'wake_ack_finished',
                    conversationId: currentConversationId,
                    pipelineId: currentConversationPipelineId,
                });
                refreshWakeSessionTimeout('指令监听超时');
            }
        }
    }

    async function handleAndSpeakCommand(command: string, commandPipelineId: string): Promise<BrainCommandResult | null> {
        const speechToken = activeSpeechToken + 1;
        activeSpeechToken = speechToken;
        activeSpeechQueueCancelled = false;
        systemSpeaking = true;
        realtimeSocket.publishVoiceSession({
            mode: 'processing',
            reason: 'voice_command_started',
            conversationId: currentConversationId,
            pipelineId: commandPipelineId,
        });
        activeSpeechText = '';
        activeSpeechStartedAt = Date.now();
        resetBargeInBuffer();
        const conversationId = ensureCurrentConversationId();

        const speechQueue = enqueueSpeechChunks(
            () => speechToken,
            (speech) => {
                if (activeSpeechToken === speechToken) {
                    activeSpeech = speech;
                }
            },
            { conversationId, logGroupId: commandPipelineId },
        );
        activeSpeechQueueCancel = speechQueue.cancel;

        try {
            const result = await handleCommand(command, {
                pipelineId: commandPipelineId,
                onTextDelta: async (delta) => {
                    if (activeSpeechToken !== speechToken || activeSpeechQueueCancelled) return;
                    activeSpeechText += delta;
                    await speechQueue.pushDelta(delta);
                },
            });
            await speechQueue.flush();
            return result;
        } finally {
            if (activeSpeechQueueCancelled) {
                speechQueue.cancel();
            }
            if (activeSpeechToken === speechToken) {
                activeSpeech = null;
                activeSpeechText = '';
                activeSpeechStartedAt = 0;
                systemSpeaking = false;
                activeSpeechQueueCancel = null;
                resetBargeInBuffer();
                realtimeSocket.publishVoiceSession({
                    mode: isAwake ? 'listening' : 'standby',
                    reason: 'voice_command_finished',
                    conversationId: currentConversationId,
                    pipelineId: commandPipelineId,
                });
                await new Promise(r => setTimeout(r, 800));

                refreshWakeSessionTimeout('会话超时');
            } else {
                speechQueue.cancel();
                if (activeSpeechQueueCancel === speechQueue.cancel) {
                    activeSpeechQueueCancel = null;
                }
            }
        }
    }

    async function flushBargeInBuffer(): Promise<void> {
        if (bargeInTranscribing || bargeInBuffer.length === 0 || !systemSpeaking || !activeSpeech) {
            return;
        }

        const audioBuffer = Buffer.concat(bargeInBuffer);
        resetBargeInBuffer();
        bargeInTranscribing = true;
        try {
            const utteranceId = `barge-in-${Date.now()}`;
            const text = await transcribeSegmentWithCache({
                audio: audioBuffer,
                segmentStartTs: bargeInStartedAt,
                segmentEndTs: bargeInLastActiveTs || Date.now(),
                reason: 'barge-in',
                logOptions: {
                conversationId: currentConversationId,
                logGroupId: currentConversationPipelineId ?? currentConversationId,
                utteranceId,
                reason: 'barge-in',
                },
            });
            const hasKeyword = GLOBAL_CONFIG.VOICE.BARGE_IN_KEYWORDS.some(keyword =>
                text.toLowerCase().includes(keyword.toLowerCase()),
            );
            const hasWakeWord = hasWakeWordInText(text, GLOBAL_CONFIG.VOICE.WAKE_WORD);
            if (!isValidBargeInTranscript(text, GLOBAL_CONFIG.VOICE.WAKE_WORD, GLOBAL_CONFIG.VOICE.BARGE_IN_KEYWORDS)) {
                return;
            }
            if (!hasKeyword && !hasWakeWord) {
                console.log(`[BargeIn] Ignored non-keyword transcript while speaking: "${text}"`);
                return;
            }
            if (!hasKeyword && isEchoLikeTranscript(text, activeSpeechText, GLOBAL_CONFIG.VOICE.BARGE_IN_ECHO_SIMILARITY)) {
                console.log(`[BargeIn] Ignored echo-like transcript: "${text}"`);
                return;
            }

            console.log(`[BargeIn] Stopping speech and entering listening mode. transcript="${text}", keyword=${hasKeyword}`);
            activeSpeechQueueCancelled = true;
            activeSpeechQueueCancel?.();
            activeSpeechQueueCancel = null;
            activeSpeech.stop();
            systemSpeaking = false;
            activeSpeech = null;
            activeSpeechText = '';
            activeSpeechStartedAt = 0;
            listenAfterInterruption();
        } catch (error) {
            console.error('[BargeIn] Failed to process interruption:', error);
        } finally {
            bargeInTranscribing = false;
        }
    }

    function segmentTimings(segment: AudioSegment, asrMs?: number) {
        return [
            { key: 'audio_segment_duration', label: '音频段长度', durationMs: segment.segmentEndTs - segment.segmentStartTs },
            { key: 'vad_tail_wait', label: 'VAD 静音收尾等待', durationMs: Math.max(0, segment.segmentEndTs - segment.lastActiveTs) },
            ...(asrMs !== undefined ? [{ key: 'asr_latency', label: 'ASR 耗时', durationMs: asrMs }] : []),
        ];
    }

    function resetListeningSegments(reason: 'system_speaking' | 'manual_reset'): void {
        wakeSegmenter.reset(reason);
        commandSegmenter.reset(reason);
        subtitleSegmenter.reset(reason);
        wakeWindowFrames = [];
    }

    function pushWakeWindowFrame(data: Buffer, level: { peak: number; rms: number }, ts: number): void {
        const active = level.peak >= GLOBAL_CONFIG.VOICE.WAKE_VAD_THRESHOLD;
        wakeWindowFrames.push({ data, ts, peak: level.peak, rms: level.rms, active });
        const windowStart = ts - GLOBAL_CONFIG.VOICE.WAKE_WINDOW_MS;
        let removeCount = 0;
        while (removeCount < wakeWindowFrames.length && wakeWindowFrames[removeCount]!.ts < windowStart) {
            removeCount++;
        }
        if (removeCount > 0) wakeWindowFrames.splice(0, removeCount);
    }

    function buildWakeProbeSegment(ts: number): AudioSegment | null {
        if (!wakeWindowFrames.length) return null;
        const first = wakeWindowFrames[0];
        const last = wakeWindowFrames[wakeWindowFrames.length - 1];
        if (!first || !last) return null;
        const activeFrames = wakeWindowFrames.filter(frame => frame.active);
        if (activeFrames.length < GLOBAL_CONFIG.VOICE.VAD_START_FRAMES) return null;
        const durationMs = ts - first.ts;
        if (durationMs < 250) return null;
        let totalBytes = 0;
        let peak = 0;
        let rmsPeak = 0;
        const buffers: Buffer[] = [];
        for (const frame of wakeWindowFrames) {
            buffers.push(frame.data);
            totalBytes += frame.data.length;
            peak = Math.max(peak, frame.peak);
            rmsPeak = Math.max(rmsPeak, frame.rms);
        }
        return {
            audio: Buffer.concat(buffers, totalBytes),
            segmentStartTs: first.ts,
            segmentEndTs: ts,
            lastActiveTs: activeFrames[activeFrames.length - 1]?.ts ?? last.ts,
            endReason: 'soft_max_duration',
            forced: false,
            frameCount: wakeWindowFrames.length,
            activeFrameCount: activeFrames.length,
            peak,
            rmsPeak,
        };
    }

    async function transcribeSegmentWithCache(input: {
        audio: Buffer;
        segmentStartTs: number;
        segmentEndTs: number;
        reason: AsrCacheReason;
        logOptions: AsrLogOptions;
    }): Promise<string> {
        const now = Date.now();
        pruneAsrCache(now);
        const hash = hashAudioWindow(input.audio);
        const cached = asrCache.find(entry =>
            entry.reason === input.reason
            && entry.audioBytes === input.audio.length
            && entry.hash === hash
            && getSegmentOverlapRatio(entry, input.segmentStartTs, input.segmentEndTs) >= ASR_DEDUPE_MIN_OVERLAP
        );
        if (cached) {
            pipelineLogs.append({
                category: 'voice-asr',
                level: 'debug',
                title: 'asr.cache_hit',
                message: `Reused ${input.reason} ASR transcript for overlapping audio window.`,
                metadata: {
                    reason: input.reason,
                    audioBytes: input.audio.length,
                    segmentStartTs: input.segmentStartTs,
                    segmentEndTs: input.segmentEndTs,
                    cachedStartTs: cached.startTs,
                    cachedEndTs: cached.endTs,
                },
                pipelineId: input.logOptions?.logGroupId ?? undefined,
                conversationId: input.logOptions?.conversationId ?? undefined,
            });
            input.logOptions?.resolveLogGroup?.(cached.text);
            return cached.text;
        }

        const text = await extractTextFromVoiceStream(input.audio, input.logOptions);
        asrCache.push({
            reason: input.reason,
            startTs: input.segmentStartTs,
            endTs: input.segmentEndTs,
            audioBytes: input.audio.length,
            hash,
            text,
            createdAt: now,
        });
        if (asrCache.length > ASR_DEDUPE_MAX_ENTRIES) {
            asrCache.splice(0, asrCache.length - ASR_DEDUPE_MAX_ENTRIES);
        }
        return text;
    }

    function pruneAsrCache(now: number): void {
        let removeCount = 0;
        while (removeCount < asrCache.length && now - asrCache[removeCount]!.createdAt > ASR_DEDUPE_CACHE_TTL_MS) {
            removeCount++;
        }
        if (removeCount > 0) asrCache.splice(0, removeCount);
    }

    function getSegmentOverlapRatio(entry: AsrCacheEntry, startTs: number, endTs: number): number {
        const duration = Math.max(1, endTs - startTs);
        const overlap = Math.max(0, Math.min(entry.endTs, endTs) - Math.max(entry.startTs, startTs));
        return overlap / duration;
    }

    function hashAudioWindow(audio: Buffer): number {
        let hash = 2166136261;
        const sampleCount = Math.min(4096, audio.length);
        const stride = Math.max(1, Math.floor(audio.length / sampleCount));
        for (let index = 0; index < audio.length; index += stride) {
            hash ^= audio[index] ?? 0;
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    async function runCommandFromVoice(command: string, commandPipelineId: string): Promise<void> {
        clearWakeSessionTimeout();
        let endedSession = false;
        try {
            const result = await handleAndSpeakCommand(command, commandPipelineId);
            if (result?.shouldRespond && result.text) {
                realtimeSocket.publishVoiceText(`[AI] ${result.text}`, Date.now(), Date.now() + 2000);
            }
            if (result?.shouldEndSession) {
                endedSession = true;
                endCurrentSession('用户结束对话，回到待机状态');
            }
        } finally {
            if (!endedSession && isAwake) {
                refreshWakeSessionTimeout('会话超时');
            }
        }
    }

    async function flushWakeSegment(segment: AudioSegment): Promise<void> {
        if (wakeTranscribing || systemSpeaking || isAwake) return;
        wakeTranscribing = true;
        const pipelineId = `wake-${segment.segmentStartTs}-${segment.segmentEndTs}`;
        const utteranceId = `wake-${segment.segmentStartTs}-${segment.segmentEndTs}`;
        const asrStartedAt = Date.now();
        try {
            const text = await transcribeSegmentWithCache({
                audio: segment.audio,
                segmentStartTs: segment.segmentStartTs,
                segmentEndTs: segment.segmentEndTs,
                reason: 'wake',
                logOptions: {
                logGroupId: pipelineId,
                utteranceId,
                reason: 'wake',
                },
            });
            const asrMs = Date.now() - asrStartedAt;
            if (!text) return;
            const wake = extractWakeCommand(text, GLOBAL_CONFIG.VOICE.WAKE_WORD);
            if (!wake.hasWakeWord) {
                if (GLOBAL_CONFIG.OLLAMA.TRACE_ENABLED) {
                    console.debug('[Wake] Wake word not detected', {
                        utteranceId,
                        wakeWord: GLOBAL_CONFIG.VOICE.WAKE_WORD,
                        text,
                        normalizedText: normalizeWakeText(text),
                        normalizedWakeWord: normalizeWakeText(GLOBAL_CONFIG.VOICE.WAKE_WORD),
                        audioBytes: segment.audio.length,
                        segmentStartTs: segment.segmentStartTs,
                        segmentEndTs: segment.segmentEndTs,
                        lastActiveTs: segment.lastActiveTs,
                        endReason: segment.endReason,
                        forcedSegment: segment.forced,
                        wakeWindowDurationMs: segment.segmentEndTs - segment.segmentStartTs,
                        wakeVadThreshold: GLOBAL_CONFIG.VOICE.WAKE_VAD_THRESHOLD,
                        asrMs,
                    });
                }
                return;
            }

            const conversationId = ensureCurrentConversationId();
            const commandPipelineId = ensureCurrentConversationPipelineId(conversationId, segment.segmentStartTs);
            isAwake = true;
            requestWakeVisionAttention('wake_word_detected');
            wakeWindowFrames = [];
            const hasCommand = hasMeaningfulWakeCommand(wake.command);
            realtimeSocket.publishVoiceSession({
                mode: hasCommand ? 'processing' : 'awake',
                reason: 'wake_word_detected',
                conversationId,
                pipelineId: commandPipelineId,
            });
            pipelineLogs.append({
                category: 'wake',
                level: 'info',
                title: 'wake_word.detected',
                message: `Wake word detected: ${GLOBAL_CONFIG.VOICE.WAKE_WORD}`,
                timings: segmentTimings(segment, asrMs),
                metadata: {
                    conversationId,
                    conversation_id: conversationId,
                    utteranceId,
                    wakeWord: GLOBAL_CONFIG.VOICE.WAKE_WORD,
                    hasCommand,
                    commandChars: wake.command.length,
                    normalizedCommandChars: wake.normalizedCommandChars,
                    wakePrefixNoiseChars: wake.prefixNoiseChars,
                    text,
                    audioBytes: segment.audio.length,
                    segmentStartTs: segment.segmentStartTs,
                    segmentEndTs: segment.segmentEndTs,
                    lastActiveTs: segment.lastActiveTs,
                    endReason: segment.endReason,
                    forcedSegment: segment.forced,
                    wakeWindowDurationMs: segment.segmentEndTs - segment.segmentStartTs,
                    bufferAgeBeforeAsr: asrStartedAt - segment.segmentEndTs,
                },
                conversationId,
                pipelineId: commandPipelineId,
            });
            if (wake.prefixNoiseChars >= GLOBAL_CONFIG.VOICE.WAKE_PREFIX_NOISE_WARN_CHARS) {
                pipelineLogs.recordIncident({
                    pipelineId: commandPipelineId,
                    stage: 'wake',
                    severity: 'warn',
                    reason: 'wake_prefix_noise_too_long',
                    outputSnapshot: text,
                    recommendedAction: 'Only use text after the wake word as command input.',
                    metadata: { wakePrefixNoiseChars: wake.prefixNoiseChars },
                });
            }
            console.log(`🎯 检测到唤醒词 [${GLOBAL_CONFIG.VOICE.WAKE_WORD}], 进入指令监听模式...`);
            if (hasCommand) {
                await runCommandFromVoice(wake.command, commandPipelineId);
            } else {
                void speakWakeAck();
                refreshWakeSessionTimeout('指令监听超时');
            }
        } catch (error) {
            console.error('Wake transcription failed:', error);
        } finally {
            wakeTranscribing = false;
        }
    }

    async function flushCommandSegment(segment: AudioSegment): Promise<void> {
        if (commandTranscribing || systemSpeaking || !isAwake) return;
        commandTranscribing = true;
        const conversationId = ensureCurrentConversationId();
        const pipelineId = ensureCurrentConversationPipelineId(conversationId, segment.segmentStartTs);
        const utteranceId = `command-${segment.segmentStartTs}-${segment.segmentEndTs}`;
        try {
            const text = await transcribeSegmentWithCache({
                audio: segment.audio,
                segmentStartTs: segment.segmentStartTs,
                segmentEndTs: segment.segmentEndTs,
                reason: 'command',
                logOptions: {
                conversationId,
                logGroupId: pipelineId,
                utteranceId,
                reason: 'command',
                },
            });
            if (!text) {
                refreshWakeSessionTimeout('指令监听超时');
                return;
            }
            realtimeSocket.publishVoiceText(text, segment.segmentStartTs, segment.segmentEndTs);
            const command = hasWakeWordInText(text, GLOBAL_CONFIG.VOICE.WAKE_WORD)
                ? extractWakeCommand(text, GLOBAL_CONFIG.VOICE.WAKE_WORD).command
                : text;
            if (!hasMeaningfulWakeCommand(command)) {
                refreshWakeSessionTimeout('指令监听超时');
                return;
            }
            pipelineLogs.append({
                category: 'wake',
                level: 'info',
                title: 'wake_session.command_detected',
                message: 'Awake session speech detected.',
                timings: segmentTimings(segment),
                metadata: {
                    conversationId,
                    conversation_id: conversationId,
                    utteranceId,
                    commandChars: command.length,
                    normalizedCommandChars: normalizeWakeText(command).length,
                    text,
                    audioBytes: segment.audio.length,
                    segmentStartTs: segment.segmentStartTs,
                    segmentEndTs: segment.segmentEndTs,
                    endReason: segment.endReason,
                    forcedSegment: segment.forced,
                },
                conversationId,
                pipelineId,
            });
            await runCommandFromVoice(command, pipelineId);
        } catch (error) {
            console.error('Command transcription failed:', error);
        } finally {
            commandTranscribing = false;
        }
    }

    async function flushSubtitleSegment(segment: AudioSegment): Promise<void> {
        if (subtitleTranscribing || systemSpeaking) return;
        subtitleTranscribing = true;
        const utteranceId = `subtitle-${segment.segmentStartTs}-${segment.segmentEndTs}`;
        try {
            const text = await transcribeSegmentWithCache({
                audio: segment.audio,
                segmentStartTs: segment.segmentStartTs,
                segmentEndTs: segment.segmentEndTs,
                reason: 'subtitle',
                logOptions: {
                logGroupId: utteranceId,
                utteranceId,
                reason: 'subtitle',
                },
            });
            if (text) {
                realtimeSocket.publishVoiceText(text, segment.segmentStartTs, segment.segmentEndTs);
            }
        } catch (error) {
            console.error('Subtitle transcription failed:', error);
        } finally {
            subtitleTranscribing = false;
        }
    }

    p2j?.on('data', (jpegBuffer: Buffer) => {
        latestVisionFrame = jpegBuffer;
        syncManager.addVideo(jpegBuffer, latestCameraRecognition);

        if (!faceRecognitionRunning && faceValue.canExecute()) {
            faceRecognitionRunning = true;
            void detectVisionFrame(jpegBuffer, (detection: HumanDetectionResult) => {
                latestCameraRecognition = buildCameraRecognitionContext(detection);

                // console.log(`[Vision] Face recognition context updated: ${JSON.stringify({
                //     recognizedLabels: latestCameraRecognition.recognizedLabels,
                //     hasStranger: latestCameraRecognition.hasStranger,
                //     faces: latestCameraRecognition.faces.map(face => ({
                //         label: face.label,
                //         matched: face.matched,
                //         candidateLabel: face.candidateLabel,
                //         distance: typeof face.distance === 'number' ? Number(face.distance.toFixed(4)) : face.distance,
                //         threshold: face.threshold,
                //         similarity: typeof face.similarity === 'number' ? Number(face.similarity.toFixed(4)) : face.similarity,
                //     })),
                //     identityVerification: latestCameraRecognition.identityVerification,
                //     bodies: detection.bodies.length,
                //     hands: detection.hands.length,
                //     objects: detection.objects.map(o => o.label),
                // })}`);
            })
                .catch((error) => {
                    console.error('Face recognition failed:', error);
                })
                .finally(() => {
                    faceRecognitionRunning = false;
                });
        }
    });

    audio.on('data', (data: Buffer) => {
        if (!firstAudioReceived) {
            console.log('🎙️ Audio data flowing into monitor...');
            firstAudioReceived = true;
        }

        syncManager.addAudio(data);
        realtimeSocket.publishVoiceChunk(data);

        const level = calculatePcmLevel(data);
        const now = Date.now();

        if (systemSpeaking) {
            resetListeningSegments('system_speaking');
            if (
                !GLOBAL_CONFIG.VOICE.BARGE_IN_ENABLED
                || !activeSpeech
                || bargeInTranscribing
                || now - activeSpeechStartedAt < GLOBAL_CONFIG.VOICE.BARGE_IN_GUARD_MS
            ) {
                return;
            }

            if (level.peak >= GLOBAL_CONFIG.VOICE.BARGE_IN_VAD_THRESHOLD) {
                if (bargeInBuffer.length === 0) {
                    bargeInStartedAt = now;
                    bargeInLastProbeTs = now;
                }
                bargeInLastActiveTs = now;
                bargeInPeak = Math.max(bargeInPeak, level.peak);
                bargeInBuffer.push(data);
                const bufferedDuration = now - bargeInStartedAt;
                const sinceLastProbe = now - bargeInLastProbeTs;
                if (
                    bufferedDuration >= GLOBAL_CONFIG.VOICE.BARGE_IN_MIN_DURATION_MS
                    && sinceLastProbe >= GLOBAL_CONFIG.VOICE.BARGE_IN_PROBE_INTERVAL_MS
                ) {
                    bargeInLastProbeTs = now;
                    void flushBargeInBuffer();
                }
                return;
            }

            if (bargeInBuffer.length > 0) {
                bargeInBuffer.push(data);
                const speechDuration = bargeInLastActiveTs - bargeInStartedAt;
                const silenceDuration = now - bargeInLastActiveTs;
                const minDuration = bargeInPeak >= GLOBAL_CONFIG.VOICE.BARGE_IN_VAD_THRESHOLD * 1.5
                    ? GLOBAL_CONFIG.VOICE.BARGE_IN_KEYWORD_MIN_DURATION_MS
                    : GLOBAL_CONFIG.VOICE.BARGE_IN_MIN_DURATION_MS;
                if (
                    speechDuration >= minDuration
                    && silenceDuration > GLOBAL_CONFIG.VOICE.BARGE_IN_SILENCE_END_MS
                ) {
                    void flushBargeInBuffer();
                    return;
                }
                if (now - bargeInStartedAt > GLOBAL_CONFIG.VOICE.BARGE_IN_MAX_BUFFER_MS) {
                    void flushBargeInBuffer();
                    return;
                }
            }
            return;
        }

        if (isAwake) {
            wakeSegmenter.reset('manual_reset');
            if (level.peak >= GLOBAL_CONFIG.VOICE.COMMAND_VAD_THRESHOLD) {
                refreshWakeSessionTimeout('指令监听超时');
            }
            const commandSegment = commandSegmenter.push(data, level, now);
            if (commandSegment) void flushCommandSegment(commandSegment);
        } else {
            commandSegmenter.reset('manual_reset');
            pushWakeWindowFrame(data, level, now);
            if (!wakeTranscribing && now - lastWakeProbeAt >= GLOBAL_CONFIG.VOICE.WAKE_PROBE_INTERVAL_MS) {
                const wakeProbe = buildWakeProbeSegment(now);
                if (wakeProbe) {
                    lastWakeProbeAt = now;
                    void flushWakeSegment(wakeProbe);
                }
            }
            const wakeSegment = wakeSegmenter.push(data, level, now);
            if (wakeSegment) void flushWakeSegment(wakeSegment);
        }

        // This transcript branch is display/observability output. Wake-word and
        // command ASR remain the input path and should not be gated by UI state.
        const subtitleSegment = subtitleSegmenter.push(data, level, now);
        if (subtitleSegment) {
            void flushSubtitleSegment(subtitleSegment);
        } else {
            logAsrVadDiagnostic('below_vad_threshold', level.peak);
        }
    });

    prewarmWakeAckInBackground('monitor_start');

    return async () => {
        if (wakeTimer) {
            clearTimeout(wakeTimer);
            wakeTimer = null;
        }
        activeSpeech?.stop();
        if (visionProfileCleanupTimer) clearInterval(visionProfileCleanupTimer);
        resetListeningSegments('manual_reset');
        audio.removeAllListeners('data');
        p2j?.removeAllListeners('data');
        if (videoRuntime && p2j) videoRuntime.stream.unpipe(p2j);
        latestVisionFrame = null;
        await Promise.allSettled([
            videoRuntime?.stop(),
            stopAudio(),
        ].filter((task): task is Promise<void> => Boolean(task)));
    };
}

async function monitorVideoOnly(): Promise<MonitorStop> {
    startRealtimeSocketServer();

    const { stream: video, stop: stopVideo } = await initCamera();
    const p2j = new Pipe2Jpeg();
    video.pipe(p2j);

    let latestCameraRecognition: CameraRecognitionContext | null = null;
    let latestVisionFrame: Buffer | null = null;
    let faceRecognitionRunning = false;
    const visionProfileCleanupTimer = setInterval(
        () => cleanupIdleVisionProfiles('video_monitor_interval'),
        VISION_PROFILE_CLEANUP_INTERVAL_MS,
    );

    p2j.on('data', (jpegBuffer: Buffer) => {
        latestVisionFrame = jpegBuffer;
        syncManager.addVideo(jpegBuffer, latestCameraRecognition);

        if (!faceRecognitionRunning && faceValue.canExecute()) {
            faceRecognitionRunning = true;
            void detectVisionFrame(jpegBuffer, (detection: HumanDetectionResult) => {
                    latestCameraRecognition = buildCameraRecognitionContext(detection);
                })
                .catch((error) => {
                    console.error('Face recognition failed:', error);
                })
                .finally(() => {
                    faceRecognitionRunning = false;
                });
        }
    });

    return async () => {
        p2j.removeAllListeners('data');
        clearInterval(visionProfileCleanupTimer);
        video.unpipe(p2j);
        latestVisionFrame = null;
        await stopVideo();
    };
}

async function monitorAudioOnly(): Promise<MonitorStop> {
    startRealtimeSocketServer();

    const { stream: audio, stop: stopAudio } = await initAudioListen();

    const audioOnlySegmenter = new AudioSegmenter({
        speechThreshold: GLOBAL_CONFIG.VOICE.SUBTITLE_VAD_THRESHOLD,
        startFrames: GLOBAL_CONFIG.VOICE.VAD_START_FRAMES,
        endFrames: GLOBAL_CONFIG.VOICE.VAD_END_FRAMES,
        softMaxDurationMs: GLOBAL_CONFIG.VOICE.SUBTITLE_SOFT_MAX_MS,
        hardMaxDurationMs: GLOBAL_CONFIG.VOICE.SUBTITLE_HARD_MAX_MS,
        cooldownMs: GLOBAL_CONFIG.VOICE.VAD_COOLDOWN_MS,
    });
    let subtitleTranscribing = false;

    async function flushAudioOnlySegment(segment: AudioSegment) {
        if (subtitleTranscribing) {
            return;
        }

        subtitleTranscribing = true;
        try {
            const utteranceId = `audio-only-${segment.segmentStartTs}-${segment.segmentEndTs}`;
            const text = await extractTextFromVoiceStream(segment.audio, {
                logGroupId: utteranceId,
                utteranceId,
                reason: 'audio-only',
            });
            if (text) {
                realtimeSocket.publishVoiceText(text, segment.segmentStartTs, segment.segmentEndTs);
            }
        } catch (error) {
            console.error('Audio transcription failed:', error);
        } finally {
            subtitleTranscribing = false;
        }
    }

    audio.on('data', (data: Buffer) => {
        realtimeSocket.publishVoiceChunk(data);
        const level = calculatePcmLevel(data);
        const now = Date.now();
        const segment = audioOnlySegmenter.push(data, level, now);
        if (segment) void flushAudioOnlySegment(segment);
    });

    return async () => {
        audio.removeAllListeners('data');
        audioOnlySegmenter.reset('manual_reset');
        await stopAudio();
    };
}

export async function stopMonitor(): Promise<void> {
    const state = getMonitorRuntimeState();
    let runtime = state.runtime;
    const starting = state.starting;
    state.runtime = undefined;
    state.starting = undefined;

    if (!runtime && starting) {
        runtime = await starting.catch((error) => {
            console.warn('Monitor startup failed while stopping:', error);
            return undefined;
        });
    }

    if (runtime) {
        await runtime.stop();
        console.log(`🛑 Sentinel Monitor stopped (${runtime.mode})`);
    }
}

export function __setMonitorRuntimeForTest(state: MonitorRuntimeState): void {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('__setMonitorRuntimeForTest is only available in test.');
    }
    const runtimeState = getMonitorRuntimeState();
    runtimeState.runtime = state.runtime;
    runtimeState.starting = state.starting;
}

export async function startMonitor(mode: MonitorMode = 'full') {
    const state = getMonitorRuntimeState();
    if (state.runtime) {
        if (state.runtime.mode === mode) {
            console.log(`↩️ Sentinel Monitor already running (${mode}); skipping duplicate start.`);
            return;
        }
        await stopMonitor();
    }
    if (state.starting) {
        await state.starting;
        return;
    }

    const label = mode === 'video' ? 'Video Demo' : mode === 'audio' ? 'Audio Demo' : 'Camera & Audio';
    state.starting = (async () => {
        const startedAt = Date.now();
        console.log(`🚀 Starting Sentinel Monitor (${label})...`);
        let stop: MonitorStop;
        if (mode === 'video') {
            stop = await monitorVideoOnly();
        } else if (mode === 'audio') {
            stop = await monitor({ video: false });
        } else {
            stop = await monitor({ video: true });
        }
        pipelineLogs.append({
            category: 'system',
            level: 'info',
            title: 'system.ready',
            message: `Sentinel Monitor ready (${label}).`,
            timings: [{ key: 'monitor_startup', label: 'Monitor startup', durationMs: Date.now() - startedAt }],
            metadata: {
                mode,
                label,
            },
            pipelineId: 'system',
        });
        return { mode, stop, startedAt: Date.now() };
    })();

    try {
        state.runtime = await state.starting;
    } catch (error) {
        console.error('❌ Monitor failed to start:', error);
        pipelineLogs.append({
            category: 'system',
            level: 'error',
            title: 'system.ready',
            message: error instanceof Error ? error.message : String(error),
            metadata: {
                mode,
                error: error instanceof Error ? error.message : String(error),
            },
            pipelineId: 'system',
        });
    } finally {
        state.starting = undefined;
    }
}
