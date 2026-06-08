import { createOllama } from 'ollama-ai-provider';
import { generateText, streamText, type CoreMessage, type UserContent } from 'ai';
import { spawn } from 'child_process';
import { GLOBAL_CONFIG } from '@/global_config';
import { memory, type ConversationMessage, type DayType, type PrunedMemoryRecord, type TimeBucket } from '@modules/memory';
import { analyzeCommand, type AnalyzeCommandInput, type IntentionAnalysis } from '@modules/intention';
import {
    buildCommandContextPrompt,
    buildMemoryPruneInstruction,
    buildMemoryPruneUserPrompt,
    buildVisionPrompt,
    getMemoryPruneSystemPrompt,
    getStewardSystemPrompt,
    type MemoryPrunePurpose,
} from '@server/prompts';
import { recordModelDecision } from '@server/observability/modelTrace';
import { generateTextWithRuntimeLog, streamTextWithRuntimeLog } from '@server/observability/modelRuntime';
import { pipelineLogs } from '@server/services/PipelineLogService';
import type { TaskTiming } from '@server/services/cosyvoice/types';
import type { AssistantLanguage } from '@tools/Socket';
import { visionAttention } from '@server/modules/vision/attention';

const ollama = createOllama({
    baseURL: GLOBAL_CONFIG.OLLAMA.IP,
});

const TEXT_MODEL_ID = GLOBAL_CONFIG.OLLAMA.TEXT_MODEL;
const VISION_MODEL_ID = GLOBAL_CONFIG.OLLAMA.VISION_MODEL;
const textModel = ollama(TEXT_MODEL_ID, {
    numCtx: GLOBAL_CONFIG.OLLAMA.TEXT_NUM_CTX,
});
const visionModel = ollama(VISION_MODEL_ID, {
    numCtx: GLOBAL_CONFIG.OLLAMA.VISION_NUM_CTX,
});
const VISION_IMAGE_MAX_EDGE = 640;
const VISION_IMAGE_JPEG_Q = 7;

export type MemoryPruneMessage = {
    role: 'user' | 'agent';
    content: string;
    createdAt?: string;
};

export interface BrainCommandResult {
    text: string;
    shouldRespond: boolean;
    shouldEndSession: boolean;
    shouldRemember: boolean;
}

type TextGenerate = typeof generateText;
type TextStream = typeof streamText;
type AnalyzeCommandFn = (input: AnalyzeCommandInput) => Promise<IntentionAnalysis>;

interface BrainProcessDeps {
    analyzeCommand?: AnalyzeCommandFn;
    generateText?: TextGenerate;
    streamText?: TextStream;
    onTextDelta?: (delta: string) => void | Promise<void>;
    pipelineId?: string;
    benchmark?: unknown;
    memory?: Pick<typeof memory, 'getRecentConversationMessages' | 'getContextMemories'>;
}

export interface CameraRecognitionContext {
    ts: number;
    ageMs?: number;
    profile?: 'identity' | 'perception' | 'full';
    requestedProfile?: 'identity' | 'perception' | 'full';
    degraded?: boolean;
    degradeReason?: string;
    faces: Array<{
        label: string;
        matched?: boolean;
        distance?: number | null;
        similarity?: number | null;
        candidateLabel?: string | null;
        threshold?: number;
        emotions?: Array<{ emotion: string; score: number }>;
        box: { x: number; y: number; width: number; height: number };
    }>;
    recognizedLabels: string[];
    hasStranger: boolean;
    identityVerification: {
        verified: boolean;
        label: string | null;
        reason: "recognized_face" | "possible_face_match" | "unknown_face" | "no_face" | "stale" | "unavailable";
        bestCandidate?: string | null;
        similarity?: number | null;
        threshold?: number;
    };
    confidence: "fresh" | "stale" | "unavailable";
    bodies?: Array<{ score: number; keypointCount: number }>;
    hands?: Array<{ score: number; handedness: string; gestures: string[] }>;
    objects?: Array<{ label: string; score: number }>;
}


function buildContextPrompt(
    userName: string,
    userCommand: string,
    language: AssistantLanguage = 'zh',
    contextMemories: PrunedMemoryRecord[] = [],
    visualSummary?: string,
    memoryRetrieval?: IntentionAnalysis['memoryRetrieval'],
): string {
    const context = {
        memoryRetrieval: memoryRetrieval
            ? {
                requested: memoryRetrieval.enabled && memoryRetrieval.mode !== 'none',
                mode: memoryRetrieval.mode,
                query: memoryRetrieval.query,
                resultCount: contextMemories.length,
                note: memoryRetrieval.mode === 'recent_recall'
                    ? 'approvedMemories are the latest approved long-term memories, not just the current wake session.'
                    : undefined,
            }
            : undefined,
        approvedMemories: contextMemories.map(item => ({
            id: item.id,
            content: item.content,
            topic: item.topic,
            userState: item.userState,
            behaviorSignal: item.behaviorSignal,
            interactionResult: item.interactionResult,
            baseScore: item.baseScore,
            status: item.status,
            createdAt: item.createdAt,
        })),
        ...(visualSummary ? { visualSummary } : {}),
    };

    return buildCommandContextPrompt({
        userName,
        userCommand,
        language,
        context,
    });
}

function buildConversationMessages(
    userName: string,
    userCommand: string,
    language: AssistantLanguage,
    contextMemories: PrunedMemoryRecord[],
    visualSummary: string | undefined,
    recentConversationMessages: ConversationMessage[],
    memoryRetrieval?: IntentionAnalysis['memoryRetrieval'],
): CoreMessage[] {
    const recentMessages: CoreMessage[] = recentConversationMessages.map(message => ({
        role: message.role === 'agent' ? 'assistant' : 'user',
        content: message.content,
    }));

    return [
        ...recentMessages,
        {
            role: 'user',
            content: buildContextPrompt(
                userName,
                userCommand,
                language,
                contextMemories,
                visualSummary,
                memoryRetrieval,
            ),
        },
    ];
}

function toImageBuffer(image: Buffer | Uint8Array | string): Buffer {
    return typeof image === 'string'
        ? Buffer.from(image, 'base64')
        : Buffer.from(image);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

async function prepareVisionImage(image: Buffer | Uint8Array | string): Promise<Buffer> {
    const input = toImageBuffer(image);
    const startedAt = Date.now();

    return new Promise((resolve) => {
        const ffmpeg = spawn(GLOBAL_CONFIG.FFMPEG.BIN, [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', 'pipe:0',
            '-an',
            '-vf', `scale='if(gt(iw,ih),min(${VISION_IMAGE_MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${VISION_IMAGE_MAX_EDGE},ih))'`,
            '-c:v', 'mjpeg',
            '-q:v', String(VISION_IMAGE_JPEG_Q),
            '-pix_fmt', 'yuvj420p',
            '-frames:v', '1',
            '-f', 'image2pipe',
            'pipe:1',
        ]);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        ffmpeg.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        ffmpeg.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        ffmpeg.stdin?.on('error', () => undefined);
        ffmpeg.once('error', (error) => {
            console.log(`[Brain] Vision image prepare skipped: ${error.message}`);
            resolve(input);
        });
        ffmpeg.once('exit', (code) => {
            const output = Buffer.concat(stdout);
            if (code !== 0 || output.length === 0) {
                const detail = Buffer.concat(stderr).toString('utf8').trim();
                console.log(`[Brain] Vision image prepare skipped: ffmpeg exited code=${code}${detail ? ` detail=${detail}` : ''}`);
                resolve(input);
                return;
            }

            console.log(`[Brain] Vision image prepared ${formatBytes(input.length)} -> ${formatBytes(output.length)} maxEdge=${VISION_IMAGE_MAX_EDGE} jpegQ=${VISION_IMAGE_JPEG_Q} durationMs=${Date.now() - startedAt}`);
            resolve(output);
        });
        ffmpeg.stdin?.end(input);
    });
}

function buildUserContent(prompt: string, image?: Buffer | Uint8Array | string): UserContent {
    if (!image) {
        return prompt;
    }

    return [
        { type: 'text', text: prompt },
        { type: 'image', image, mimeType: 'image/jpeg' },
    ];
}

function summarizeCameraContext(cameraContext?: CameraRecognitionContext): string {
    if (!cameraContext) {
        return JSON.stringify({ cameraRecognition: { confidence: 'unavailable', faces: [] } });
    }

    return JSON.stringify({
        cameraRecognition: {
            ts: cameraContext.ts,
            ageMs: cameraContext.ageMs ?? Date.now() - cameraContext.ts,
            confidence: cameraContext.confidence,
            profile: cameraContext.profile,
            requestedProfile: cameraContext.requestedProfile,
            degraded: cameraContext.degraded,
            degradeReason: cameraContext.degradeReason,
            recognizedLabels: cameraContext.recognizedLabels,
            hasStranger: cameraContext.hasStranger,
            faces: cameraContext.faces.map(face => ({
                label: face.label,
                matched: face.matched,
                candidateLabel: face.candidateLabel,
                similarity: typeof face.similarity === 'number' ? Number(face.similarity.toFixed(3)) : face.similarity,
                threshold: face.threshold,
                emotions: face.emotions?.slice(0, 2),
            })),
            identityVerification: cameraContext.identityVerification,
            bodies: (cameraContext.bodies ?? []).map(b => ({ score: b.score, keypointCount: b.keypointCount })),
            hands: (cameraContext.hands ?? []).map(h => ({ handedness: h.handedness, gestures: h.gestures })),
            objects: cameraContext.objects ?? [],
        },
    });
}

export class HomeBrain {
    async processCommandDetailed(
        userCommand: string,
        userName: string,
        cameraContext?: CameraRecognitionContext,
        language: AssistantLanguage = 'zh',
        image?: Buffer | Uint8Array | string,
        conversationId?: string,
        deps: BrainProcessDeps = {},
    ): Promise<BrainCommandResult> {
        const memoryStore = deps.memory ?? memory;
        const analyze = deps.analyzeCommand ?? analyzeCommand;
        const generate = deps.generateText ?? generateText;
        const now = new Date();
        const traceId = createTraceId();
        const pipelineId = deps.pipelineId ?? traceId;
        const ownsPipeline = !deps.pipelineId;
        const pipelineStartedAt = Date.now();
        const completeConversationPipeline = (status: 'completed' | 'failed', outcome: string): void => {
            if (!ownsPipeline) return;
            pipelineLogs.completePipeline(pipelineId, {
                status,
                summary: {
                    userIntent: intention.intent,
                    topic: userCommand,
                    language,
                    usedMemory: false,
                    usedVision: false,
                    usedTool: false,
                    responseMode: outcome,
                    latencyMs: Date.now() - pipelineStartedAt,
                },
                metadata: {
                    conversationId,
                    traceId,
                    userCommand,
                    outcome,
                },
            });
        };
        const logPipelineStage = (
            title: string,
            timing: TaskTiming,
            extra: { level?: 'info' | 'warn' | 'error'; message?: string; metadata?: Record<string, unknown> } = {},
        ): void => {
            if (!conversationId) return;
            pipelineLogs.append({
                category: 'system',
                level: extra.level ?? 'info',
                title,
                message: extra.message,
                pipelineId,
                timings: [timing],
                metadata: {
                    conversationId,
                    pipelineId,
                    traceId,
                    userCommand,
                    ...(extra.metadata ?? {}),
                },
            });
        };
        const recentContextStartedAt = Date.now();
        const recentConversationMessages = conversationId
            ? memoryStore.getRecentConversationMessages({ conversationId, limit: 8 })
            : [];
        logPipelineStage('Recent conversation context', {
            key: 'recent_context',
            label: 'Recent context',
            durationMs: Date.now() - recentContextStartedAt,
            detail: `${recentConversationMessages.length} message(s)`,
        }, {
            metadata: { recentConversationCount: recentConversationMessages.length },
        });
        const intentionStartedAt = Date.now();
        const intention = await analyze({
            userCommand,
            language,
            recentConversationMessages,
            traceId,
            pipelineId,
            conversationId,
            benchmark: deps.benchmark,
        });
        logPipelineStage('Intent routing', {
            key: 'intent_routing',
            label: 'Intent routing',
            durationMs: Date.now() - intentionStartedAt,
            detail: intention.intent,
        }, {
            metadata: {
                intent: intention.intent,
                dialogueAct: intention.dialogueAct,
                routingAction: intention.routingAction ?? intention.routing?.action,
            },
        });
        const routingAction = intention.routingAction ?? intention.routing?.action;
        const memoryPlan = intention.dataPlan?.memory;
        const visionPlan = intention.dataPlan?.vision;
        const needsVision = intention.intent === 'visual' || visionPlan?.needed === true || intention.visualUnderstanding?.required === true;
        if (needsVision) {
            visionAttention.request({
                id: 'intent-vision',
                source: 'intent',
                profile: GLOBAL_CONFIG.VISION.INTENT_PROFILE,
                priority: 80,
                reason: intention.visualUnderstanding?.reason ?? visionPlan?.reason ?? 'visual_intent',
                ttlMs: GLOBAL_CONFIG.VISION.INTENT_TTL_MS,
            });
        } else {
            visionAttention.clearSource('intent');
        }
        const requiresLongTermMemory = intention.requiresLongTermMemory ?? (memoryPlan?.needed === true || (intention.memoryRetrieval.enabled && intention.memoryRetrieval.mode !== 'none'));
        const requiresToolsOrMCP = intention.requiresToolsOrMCP ?? (needsVision || intention.dataPlan?.deviceState?.needed === true);
        console.log(`[Brain] Camera context ${needsVision ? 'reserved for vision model' : 'withheld from text model'}: ${summarizeCameraContext(cameraContext)}`);
        console.log(`[Brain] Using text model ${TEXT_MODEL_ID}${needsVision ? ` with vision model ${VISION_MODEL_ID}` : ''}; visionReason="${intention.visualUnderstanding?.reason ?? 'not requested'}"`);
        if (routingAction === 'ignore' || !intention.shouldRespond) {
            logPipelineStage('Routing result', {
                key: 'routing_result',
                label: 'Routing result',
                durationMs: 0,
                detail: 'ignored',
            }, {
                message: 'Input ignored by intent routing',
                metadata: { routingAction, shouldRespond: intention.shouldRespond },
            });
            logPipelineStage('Conversation pipeline complete', {
                key: 'conversation_total',
                label: 'Total',
                durationMs: Date.now() - pipelineStartedAt,
                detail: 'ignored',
            });
            completeConversationPipeline('completed', 'ignored');
            return {
                text: '',
                shouldRespond: false,
                shouldEndSession: intention.shouldEndSession,
                shouldRemember: false,
            };
        }
        if (routingAction === 'end_session' || intention.shouldEndSession) {
            logPipelineStage('Routing result', {
                key: 'routing_result',
                label: 'Routing result',
                durationMs: 0,
                detail: 'end_session',
            }, {
                message: 'Conversation ended by intent routing',
                metadata: { routingAction, shouldEndSession: intention.shouldEndSession },
            });
            logPipelineStage('Conversation pipeline complete', {
                key: 'conversation_total',
                label: 'Total',
                durationMs: Date.now() - pipelineStartedAt,
                detail: 'ended',
            });
            completeConversationPipeline('completed', 'ended');
            return {
                text: language === 'en' ? 'Okay, call me anytime.' : '好的，随时叫我。',
                shouldRespond: true,
                shouldEndSession: true,
                shouldRemember: false,
            };
        }
        const responseCommand = intention.resolvedContext.rewriteQuery || intention.contextResolution?.responseRewrite || intention.resolvedContext.rewrite || userCommand;
        const retrieval = intention.memoryRetrieval;
        const shouldFetchMemory = requiresLongTermMemory;
        const memoryMode = memoryPlan?.mode ?? retrieval.mode;
        const memoryQuery = intention.resolvedContext.rewriteQuery || memoryPlan?.query || retrieval.query || intention.contextResolution?.memoryQueryRewrite || responseCommand;
        const dataFetchStartedAt = Date.now();
        const memoryFetchStartedAt = Date.now();
        const toolFetchStartedAt = Date.now();
        const [contextMemories, toolOrMcpContext] = await Promise.all([
            shouldFetchMemory && memoryMode !== 'none'
                ? Promise.resolve(memoryStore.getContextMemories({
                        query: memoryQuery,
                        location: 'unknown',
                        timeBucket: getTimeBucket(now),
                        dayType: getDayType(now),
                        limit: 5,
                        mode: memoryMode,
                    }))
                    .then(items => {
                        recordModelDecision('Brain', 'rag_fetch_complete', {
                            pipelineId,
                            conversationId,
                            traceId,
                            query: memoryQuery,
                            mode: memoryMode,
                            durationMs: Date.now() - memoryFetchStartedAt,
                            resultCount: items.length,
                        });
                        return items;
                    })
                : Promise.resolve([]),
            requiresToolsOrMCP
                ? this.readToolOrMcpContext({
                    responseCommand,
                    language,
                    image,
                    cameraContext,
                    generate,
                    needsVision,
                    traceId,
                    conversationId,
                    pipelineId,
                    startedAt: toolFetchStartedAt,
                    benchmark: deps.benchmark,
                })
                : Promise.resolve(undefined),
        ]);
        logPipelineStage('Context data fetch', {
            key: 'context_data_fetch',
            label: 'Context data',
            durationMs: Date.now() - dataFetchStartedAt,
            detail: `${contextMemories.length} memory item(s)`,
        }, {
            metadata: {
                memory: {
                    fetched: shouldFetchMemory && memoryMode !== 'none',
                    mode: memoryMode,
                    query: memoryQuery,
                    resultCount: contextMemories.length,
                },
                toolsOrMCP: requiresToolsOrMCP,
                vision: Boolean(toolOrMcpContext?.visualSummary),
            },
        });
        const visualSummary = toolOrMcpContext?.visualSummary;
        const conversationMessages = buildConversationMessages(
            userName,
            responseCommand,
            language,
            contextMemories,
            visualSummary,
            recentConversationMessages,
            retrieval,
        );

        recordModelDecision('Brain', 'response_context', {
            pipelineId,
            conversationId,
            traceId,
            responseCommand,
            routing: intention.routing,
            dataPlan: intention.dataPlan,
            responsePlan: intention.responsePlan,
            memoryRetrieval: retrieval,
            parallelFetch: {
                memory: shouldFetchMemory && memoryMode !== 'none',
                toolsOrMCP: requiresToolsOrMCP,
                vision: Boolean(toolOrMcpContext?.visualSummary),
            },
            injectedMemories: contextMemories.map(item => ({
                id: item.id,
                topic: item.topic,
                status: item.status,
                baseScore: item.baseScore,
                content: item.content,
            })),
            visualSummary,
            recentConversationCount: recentConversationMessages.length,
            messages: conversationMessages,
        });

        const responseStartedAt = Date.now();
        let responseText = '';
        try {
            responseText = await this.generateResponseText(
                conversationMessages,
                language,
                { traceId, conversationId, pipelineId, userCommand },
                deps,
            );
        } catch (error) {
            logPipelineStage('Response generation failed', {
                key: 'response_generation',
                label: 'Response generation',
                durationMs: Date.now() - responseStartedAt,
                detail: error instanceof Error ? error.message : String(error),
            }, {
                level: 'error',
                metadata: { error: error instanceof Error ? error.message : String(error) },
            });
            logPipelineStage('Conversation pipeline failed', {
                key: 'conversation_total',
                label: 'Total',
                durationMs: Date.now() - pipelineStartedAt,
                detail: 'failed',
            }, {
                level: 'error',
            });
            completeConversationPipeline('failed', 'failed');
            throw error;
        }
        logPipelineStage('Response generation', {
            key: 'response_generation',
            label: 'Response generation',
            durationMs: Date.now() - responseStartedAt,
            detail: `${responseText.length} character(s)`,
        }, {
            metadata: { responseLength: responseText.length },
        });
        logPipelineStage('Conversation pipeline complete', {
            key: 'conversation_total',
            label: 'Total',
            durationMs: Date.now() - pipelineStartedAt,
            detail: 'responded',
        });
        if (ownsPipeline) {
            pipelineLogs.completePipeline(pipelineId, {
                status: 'completed',
                summary: {
                    userIntent: intention.intent,
                    topic: responseCommand,
                    language,
                    usedMemory: contextMemories.length > 0,
                    usedVision: Boolean(visualSummary),
                    usedTool: requiresToolsOrMCP,
                    responseMode: 'responded',
                    latencyMs: Date.now() - pipelineStartedAt,
                    responseChars: responseText.length,
                },
                metadata: {
                    conversationId,
                    traceId,
                    userCommand,
                    responseCommand,
                },
            });
        }

        return {
            text: responseText,
            shouldRespond: true,
            shouldEndSession: false,
            shouldRemember: true,
        };
    }

    async processCommand(
        userCommand: string,
        userName: string,
        cameraContext?: CameraRecognitionContext,
        language: AssistantLanguage = 'zh',
        image?: Buffer | Uint8Array | string,
        conversationId?: string,
    ): Promise<string> {
        const result = await this.processCommandDetailed(
            userCommand,
            userName,
            cameraContext,
            language,
            image,
            conversationId,
        );
        return result.text;
    }

    private async describeVision(
        userCommand: string,
        language: AssistantLanguage,
        image?: Buffer | Uint8Array | string,
        cameraContext?: CameraRecognitionContext,
        generate: TextGenerate = generateText,
    traceContext: { traceId?: string; conversationId?: string; pipelineId?: string; userCommand?: string; benchmark?: unknown } = {},
    ): Promise<string> {
        if (!image) {
            return language === 'en'
                ? 'No current camera frame is available.'
                : '当前没有可用的摄像头画面。';
        }

        const preparedImage = await prepareVisionImage(image);
        const detectorReference = summarizeCameraContext(cameraContext);
        const prompt = buildVisionPrompt({
            userCommand,
            detectorReference,
            language,
        });
        recordModelDecision('Vision', 'request', {
            pipelineId: traceContext.pipelineId,
            conversationId: traceContext.conversationId,
            traceId: traceContext.traceId,
            userCommand,
            detectorReference,
            prompt,
            imageBytes: preparedImage.length,
        });

        const options = {
            model: visionModel as any,
            maxTokens: GLOBAL_CONFIG.OLLAMA.VISION_MAX_TOKENS,
            temperature: GLOBAL_CONFIG.OLLAMA.VISION_TEMPERATURE,
            messages: [
                {
                    role: 'user',
                    content: buildUserContent(prompt, preparedImage),
                },
            ] satisfies CoreMessage[],
        };
        const result = generate === generateText
            ? await generateTextWithRuntimeLog(generate, options, {
                scope: 'vision.summary',
                modelId: VISION_MODEL_ID,
                traceId: traceContext.traceId,
                conversationId: traceContext.conversationId,
                pipelineId: traceContext.pipelineId,
                userCommand: traceContext.userCommand ?? userCommand,
                benchmark: traceContext.benchmark,
            })
            : await generate(options);
        return result.text.trim();
    }

    private async readToolOrMcpContext(input: {
        responseCommand: string;
        language: AssistantLanguage;
        image?: Buffer | Uint8Array | string;
        cameraContext?: CameraRecognitionContext;
        generate: TextGenerate;
        needsVision: boolean;
        traceId: string;
        conversationId?: string;
        pipelineId?: string;
        startedAt: number;
        benchmark?: unknown;
    }): Promise<{ visualSummary?: string }> {
        const visualSummary = input.needsVision
            ? await this.describeVision(
                input.responseCommand,
                input.language,
                input.image,
                input.cameraContext,
                input.generate,
                { traceId: input.traceId, conversationId: input.conversationId, pipelineId: input.pipelineId, userCommand: input.responseCommand, benchmark: input.benchmark },
            )
            : undefined;

        recordModelDecision('Brain', 'tool_or_mcp_fetch_complete', {
            pipelineId: input.pipelineId,
            conversationId: input.conversationId,
            traceId: input.traceId,
            durationMs: Date.now() - input.startedAt,
            vision: Boolean(visualSummary),
        });

        return { visualSummary };
    }

    private async generateResponseText(
        messages: CoreMessage[],
        language: AssistantLanguage,
        traceContext: { traceId?: string; conversationId?: string; pipelineId?: string; userCommand?: string },
        deps: BrainProcessDeps,
    ): Promise<string> {
        const options = {
            model: textModel as any,
            system: getSystemPrompt(language),
            maxTokens: GLOBAL_CONFIG.OLLAMA.TEXT_MAX_TOKENS,
            temperature: GLOBAL_CONFIG.OLLAMA.TEXT_TEMPERATURE,
            topP: GLOBAL_CONFIG.OLLAMA.TEXT_TOP_P,
            messages,
        };

        if (!deps.streamText && deps.generateText) {
            const result = await deps.generateText(options);
            if (result.text && deps.onTextDelta) {
                await deps.onTextDelta(result.text);
            }
            return result.text;
        }

        const stream = deps.streamText ?? streamText;
        const result = stream === streamText
            ? await streamTextWithRuntimeLog(stream, options, {
                scope: 'brain.response',
                modelId: TEXT_MODEL_ID,
                traceId: traceContext.traceId,
                conversationId: traceContext.conversationId,
                pipelineId: traceContext.pipelineId,
                userCommand: traceContext.userCommand,
                benchmark: deps.benchmark,
            })
            : await stream(options);
        let fullText = '';
        for await (const delta of result.textStream) {
            fullText += delta;
            if (deps.onTextDelta) {
                await deps.onTextDelta(delta);
            }
        }

        return fullText;
    }
}

export async function pruneConversationForMemory(
    messages: MemoryPruneMessage[],
    language: AssistantLanguage = 'zh',
    instruction?: string,
    purpose?: MemoryPrunePurpose,
): Promise<string> {
    const transcript = messages
        .map(message => `${message.role === 'user' ? 'User' : 'Agent'}: ${message.content}`)
        .join('\n');
    const effectiveInstruction = buildMemoryPruneInstruction({ instruction, purpose, language });
    const prompt = buildMemoryPruneUserPrompt({
        transcript,
        instruction,
        purpose,
        language,
    });
    recordModelDecision('MemoryPrune', 'request', {
        messageCount: messages.length,
        purpose: purpose ?? 'long_term_lifestyle',
        instruction: effectiveInstruction,
        prompt,
    });

    const options = {
        model: textModel as any,
        maxTokens: GLOBAL_CONFIG.OLLAMA.TEXT_MAX_TOKENS,
        temperature: GLOBAL_CONFIG.OLLAMA.TEXT_TEMPERATURE,
        topP: GLOBAL_CONFIG.OLLAMA.TEXT_TOP_P,
        system: getMemoryPruneSystemPrompt(language),
        prompt,
    };
    const result = await generateTextWithRuntimeLog(generateText, options, {
        scope: 'memory.prune',
        modelId: TEXT_MODEL_ID,
    });
    recordModelDecision('MemoryPrune', 'draft_raw_output', result.text);

    return result.text.trim();
}

function getTimeBucket(date: Date): TimeBucket {
    const hour = date.getHours();
    if (hour >= 5 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 14) return 'noon';
    if (hour >= 14 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 23) return 'evening';
    return 'night';
}

function getDayType(date: Date): DayType {
    const day = date.getDay();
    return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

function getSystemPrompt(language: AssistantLanguage): string {
    return getStewardSystemPrompt(language);
}

function createTraceId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const brain = new HomeBrain();
