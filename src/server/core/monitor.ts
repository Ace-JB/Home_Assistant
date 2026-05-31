import { GLOBAL_CONFIG } from '@/global_config';
import { initCamera } from "@tools/Camera";
import {
    extractTextFromVoiceStream,
    extractSpeechReadyChunk,
    initAudioListen,
    isEchoLikeTranscript,
    isValidBargeInTranscript,
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

const SUBTITLE_VAD_THRESHOLD = 0.05; // 过滤背景低频噪点
const MAX_SUBTITLE_DURATION_MS = 10000; // 单次录音最长 10 秒
const SILENCE_END_MS = 800; // 连续静音 800ms 认为说话结束

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

async function monitor(): Promise<MonitorStop> {
    startRealtimeSocketServer();
    await validateTextToSpeechConfig().catch((error) => {
        console.warn('[TTS] config validation failed; monitor will continue without blocking camera/audio startup:', error);
    });

    const [{ stream: video, stop: stopVideo }, { stream: audio, stop: stopAudio }] = await Promise.all([
        initCamera(),
        initAudioListen(),
    ]);

    const p2j = new Pipe2Jpeg();
    video.pipe(p2j);

    let subtitleBuffer: Buffer[] = [];
    let subtitleBufferStartedAt = 0;
    let lastActiveTs = 0;
    let isSpeaking = false;
    let systemSpeaking = false; // 新增：系统是否正在说话
    let subtitleTranscribing = false;
    let isAwake = false;
    let currentConversationId: string | null = null;
    let wakeTimer: any = null;
    let latestCameraRecognition: CameraRecognitionContext | null = null;
    let latestVisionFrame: Buffer | null = null;
    let faceRecognitionRunning = false;
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

    function resetBargeInBuffer(): void {
        bargeInBuffer = [];
        bargeInStartedAt = 0;
        bargeInLastActiveTs = 0;
        bargeInPeak = 0;
        bargeInLastProbeTs = 0;
    }

    function listenAfterInterruption(): void {
        isAwake = true;
        subtitleBuffer = [];
        subtitleBufferStartedAt = 0;
        lastActiveTs = 0;
        isSpeaking = false;
        if (wakeTimer) {
            clearTimeout(wakeTimer);
        }
        wakeTimer = setTimeout(() => {
            queueMemoryCandidateForSession(currentConversationId);
            isAwake = false;
            currentConversationId = null;
            console.log("💤 打断后监听超时，回到待机状态");
        }, 15000);
    }

    function endCurrentSession(reason: string): void {
        queueMemoryCandidateForSession(currentConversationId);
        isAwake = false;
        currentConversationId = null;
        if (wakeTimer) {
            clearTimeout(wakeTimer);
            wakeTimer = null;
        }
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
        deps: { onTextDelta?: (delta: string) => void | Promise<void> } = {},
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
        if (!currentConversationId) {
            currentConversationId = memory.createConversationSession().conversationId;
            console.log(`🧠 新会话记忆已创建: ${currentConversationId}`);
        }
        memory.appendConversationTurn({
            conversation_id: currentConversationId,
            user_content: trimmed,
            agent_content: result.text,
        });

        return result;
    }

    function enqueueSpeechChunks(
        getToken: () => number,
        onDone: (speech: InterruptibleSpeech | null) => void,
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
                const speech = item.speech ?? speakInterruptible(item.text);
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
                speech: prewarmCosyVoice ? speakInterruptible(chunk) : undefined,
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
        systemSpeaking = true;
        activeSpeechText = response;
        activeSpeechStartedAt = Date.now();
        resetBargeInBuffer();
        activeSpeech = speakInterruptible(response);
        try {
            await activeSpeech.done;
        } finally {
            if (activeSpeechToken === speechToken) {
                activeSpeech = null;
                activeSpeechText = '';
                activeSpeechStartedAt = 0;
                systemSpeaking = false;
                resetBargeInBuffer();
            }
            await new Promise(r => setTimeout(r, 800));

            if (activeSpeechToken !== speechToken) {
                return;
            }
            if (wakeTimer) clearTimeout(wakeTimer);
            wakeTimer = setTimeout(() => {
                isAwake = false;
                currentConversationId = null;
                console.log("💤 会话超时，回到待机状态");
            }, 15000);
        }
    }

    async function handleAndSpeakCommand(command: string): Promise<BrainCommandResult | null> {
        const speechToken = activeSpeechToken + 1;
        activeSpeechToken = speechToken;
        activeSpeechQueueCancelled = false;
        systemSpeaking = true;
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
        );

        try {
            const result = await handleCommand(command, {
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
                resetBargeInBuffer();
                await new Promise(r => setTimeout(r, 800));

                if (wakeTimer) clearTimeout(wakeTimer);
                wakeTimer = setTimeout(() => {
                    queueMemoryCandidateForSession(currentConversationId);
                    isAwake = false;
                    currentConversationId = null;
                    console.log("💤 会话超时，回到待机状态");
                }, 15000);
            } else {
                speechQueue.cancel();
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
            const text = await extractTextFromVoiceStream(audioBuffer);
            const hasKeyword = GLOBAL_CONFIG.VOICE.BARGE_IN_KEYWORDS.some(keyword =>
                text.toLowerCase().includes(keyword.toLowerCase()),
            );
            const hasWakeWord = text.includes(GLOBAL_CONFIG.VOICE.WAKE_WORD);
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

    async function flushSubtitleBuffer() {
        if (subtitleTranscribing || subtitleBuffer.length === 0 || systemSpeaking) {
            return;
        }

        const audioStartTs = subtitleBufferStartedAt;
        const audioEndTs = Date.now();
        const audioBuffer = Buffer.concat(subtitleBuffer);

        // 重置状态
        subtitleBuffer = [];
        subtitleBufferStartedAt = 0;
        lastActiveTs = 0;
        isSpeaking = false;

        subtitleTranscribing = true;
        try {
            const text = await extractTextFromVoiceStream(audioBuffer);
            if (text) {
                realtimeSocket.publishVoiceText(text, audioStartTs, audioEndTs);

                // --- 语音指令逻辑：唤醒词 & 会话状态检测 ---
                const wakeWord = GLOBAL_CONFIG.VOICE.WAKE_WORD;
                const hasWakeWord = text.includes(wakeWord);

                if (hasWakeWord || isAwake) {
                    let command = hasWakeWord ? text.split(wakeWord).pop()?.trim() : text;

                    // 如果包含唤醒词，进入唤醒状态并开启/重置计时器
                    if (hasWakeWord) {
                        console.log(`🎯 检测到唤醒词 [${wakeWord}], 进入指令监听模式...`);
                        isAwake = true;
                        if (!command && GLOBAL_CONFIG.VOICE.TTS_PROVIDER !== 'cosyvoice') {
                            void speakResponse('我在');
                        }
                    }

                    // 只要检测到可能是指令，立即清除旧的倒计时，防止在思考/说话期间超时
                    if (wakeTimer) {
                        clearTimeout(wakeTimer);
                        wakeTimer = null;
                    }

                    if (command && command.length > 1) {
                        const result = await handleAndSpeakCommand(command);
                        if (result?.shouldRespond && result.text) {
                            realtimeSocket.publishVoiceText(`[AI] ${result.text}`, Date.now(), Date.now() + 2000);
                        }
                        if (result?.shouldEndSession) {
                            endCurrentSession('用户结束对话，回到待机状态');
                        }
                    } else if (hasWakeWord) {
                        // 如果只有唤醒词而没有后续指令，启动基础超时计时
                        wakeTimer = setTimeout(() => {
                            queueMemoryCandidateForSession(currentConversationId);
                            isAwake = false;
                            currentConversationId = null;
                            console.log("💤 指令监听超时，回到待机状态");
                        }, 15000);
                    }
                }
            }
        } catch (error) {
            console.error('Subtitle transcription failed:', error);
        } finally {
            subtitleTranscribing = false;
        }
    }

    p2j.on('data', (jpegBuffer: Buffer) => {
        latestVisionFrame = jpegBuffer;
        syncManager.addVideo(jpegBuffer, latestCameraRecognition);

        if (!faceRecognitionRunning && faceValue.canExecute()) {
            faceRecognitionRunning = true;
            void faceEngine.detectAll(jpegBuffer)
                .then((detection: HumanDetectionResult) => {
                    latestCameraRecognition = buildCameraRecognitionContext(detection);

                    // 广播完整感知数据到前端
                    realtimeSocket.publishVisionDetection(detection);

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

        // 计算当前音频块的能量
        const { peak } = calculatePcmLevel(data);
        const now = Date.now();

        if (systemSpeaking) {
            if (
                !GLOBAL_CONFIG.VOICE.BARGE_IN_ENABLED
                || !activeSpeech
                || bargeInTranscribing
                || now - activeSpeechStartedAt < GLOBAL_CONFIG.VOICE.BARGE_IN_GUARD_MS
            ) {
                return;
            }

            if (peak >= GLOBAL_CONFIG.VOICE.BARGE_IN_VAD_THRESHOLD) {
                if (bargeInBuffer.length === 0) {
                    bargeInStartedAt = now;
                    bargeInLastProbeTs = now;
                }
                bargeInLastActiveTs = now;
                bargeInPeak = Math.max(bargeInPeak, peak);
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

        if (!realtimeSocket.isRealtimeSubtitleEnabled()) {
            subtitleBuffer = [];
            isSpeaking = false;
            return;
        }

        if (peak >= SUBTITLE_VAD_THRESHOLD) {
            // 检测到声音
            if (!isSpeaking) {
                isSpeaking = true;
                subtitleBufferStartedAt = now;
            }
            lastActiveTs = now;
            subtitleBuffer.push(data);
        } else {
            // 静音阶段
            if (isSpeaking) {
                subtitleBuffer.push(data);
                // 检查是否静音超过阈值 或者 录音时间过长
                const silenceDuration = now - lastActiveTs;
                const totalDuration = now - subtitleBufferStartedAt;

                if (silenceDuration > SILENCE_END_MS || totalDuration > MAX_SUBTITLE_DURATION_MS) {
                    void flushSubtitleBuffer();
                }
            }
        }
    });

    return async () => {
        if (wakeTimer) {
            clearTimeout(wakeTimer);
            wakeTimer = null;
        }
        activeSpeech?.stop();
        audio.removeAllListeners('data');
        p2j.removeAllListeners('data');
        video.unpipe(p2j);
        latestVisionFrame = null;
        await Promise.allSettled([stopVideo(), stopAudio()]);
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

    p2j.on('data', (jpegBuffer: Buffer) => {
        latestVisionFrame = jpegBuffer;
        syncManager.addVideo(jpegBuffer, latestCameraRecognition);

        if (!faceRecognitionRunning && faceValue.canExecute()) {
            faceRecognitionRunning = true;
            void faceEngine.detectAll(jpegBuffer)
                .then((detection: HumanDetectionResult) => {
                    latestCameraRecognition = buildCameraRecognitionContext(detection);
                    realtimeSocket.publishVisionDetection(detection);
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
        video.unpipe(p2j);
        latestVisionFrame = null;
        await stopVideo();
    };
}

async function monitorAudioOnly(): Promise<MonitorStop> {
    startRealtimeSocketServer();

    const { stream: audio, stop: stopAudio } = await initAudioListen();

    let subtitleBuffer: Buffer[] = [];
    let subtitleBufferStartedAt = 0;
    let lastActiveTs = 0;
    let isSpeaking = false;
    let subtitleTranscribing = false;

    async function flushSubtitleBuffer() {
        if (subtitleTranscribing || subtitleBuffer.length === 0) {
            return;
        }

        const audioStartTs = subtitleBufferStartedAt;
        const audioEndTs = Date.now();
        const audioBuffer = Buffer.concat(subtitleBuffer);

        subtitleBuffer = [];
        subtitleBufferStartedAt = 0;
        lastActiveTs = 0;
        isSpeaking = false;
        subtitleTranscribing = true;
        try {
            const text = await extractTextFromVoiceStream(audioBuffer);
            if (text) {
                realtimeSocket.publishVoiceText(text, audioStartTs, audioEndTs);
            }
        } catch (error) {
            console.error('Audio transcription failed:', error);
        } finally {
            subtitleTranscribing = false;
        }
    }

    audio.on('data', (data: Buffer) => {
        if (!realtimeSocket.isRealtimeSubtitleEnabled()) {
            subtitleBuffer = [];
            isSpeaking = false;
            return;
        }

        realtimeSocket.publishVoiceChunk(data);
        const { peak } = calculatePcmLevel(data);
        const now = Date.now();

        if (peak >= SUBTITLE_VAD_THRESHOLD) {
            if (!isSpeaking) {
                isSpeaking = true;
                subtitleBufferStartedAt = now;
            }
            lastActiveTs = now;
            subtitleBuffer.push(data);
            return;
        }

        if (isSpeaking) {
            subtitleBuffer.push(data);
            const silenceDuration = now - lastActiveTs;
            const totalDuration = now - subtitleBufferStartedAt;
            if (silenceDuration > SILENCE_END_MS || totalDuration > MAX_SUBTITLE_DURATION_MS) {
                void flushSubtitleBuffer();
            }
        }
    });

    return async () => {
        audio.removeAllListeners('data');
        subtitleBuffer = [];
        await stopAudio();
    };
}

export async function stopMonitor(): Promise<void> {
    const state = getMonitorRuntimeState();
    const runtime = state.runtime;
    state.runtime = undefined;
    state.starting = undefined;
    if (runtime) {
        await runtime.stop();
        console.log(`🛑 Sentinel Monitor stopped (${runtime.mode})`);
    }
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
        console.log(`🚀 Starting Sentinel Monitor (${label})...`);
        let stop: MonitorStop;
        if (mode === 'video') {
            stop = await monitorVideoOnly();
        } else if (mode === 'audio') {
            stop = await monitorAudioOnly();
        } else {
            stop = await monitor();
        }
        return { mode, stop, startedAt: Date.now() };
    })();

    try {
        state.runtime = await state.starting;
    } catch (error) {
        console.error('❌ Monitor failed to start:', error);
    } finally {
        state.starting = undefined;
    }
}
