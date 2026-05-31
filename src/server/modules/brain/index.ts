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
import { traceModelDecision } from '@server/observability/modelTrace';
import type { AssistantLanguage } from '@tools/Socket';

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
    memory?: Pick<typeof memory, 'getRecentConversationMessages' | 'getContextMemories'>;
}

export interface CameraRecognitionContext {
    ts: number;
    ageMs?: number;
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
        const recentConversationMessages = conversationId
            ? memoryStore.getRecentConversationMessages({ conversationId, limit: 8 })
            : [];
        const intention = await analyze({
            userCommand,
            language,
            recentConversationMessages,
            traceId,
        });
        const routingAction = intention.routingAction ?? intention.routing?.action;
        const memoryPlan = intention.dataPlan?.memory;
        const visionPlan = intention.dataPlan?.vision;
        const needsVision = intention.intent === 'visual' || visionPlan?.needed === true || intention.visualUnderstanding?.required === true;
        const requiresLongTermMemory = intention.requiresLongTermMemory ?? (memoryPlan?.needed === true || (intention.memoryRetrieval.enabled && intention.memoryRetrieval.mode !== 'none'));
        const requiresToolsOrMCP = intention.requiresToolsOrMCP ?? (needsVision || intention.dataPlan?.deviceState?.needed === true);
        console.log(`[Brain] Camera context ${needsVision ? 'reserved for vision model' : 'withheld from text model'}: ${summarizeCameraContext(cameraContext)}`);
        console.log(`[Brain] Using text model ${TEXT_MODEL_ID}${needsVision ? ` with vision model ${VISION_MODEL_ID}` : ''}; visionReason="${intention.visualUnderstanding?.reason ?? 'not requested'}"`);
        traceModelDecision('Brain', 'intention_decision', {
            traceId,
            userCommand,
            intention,
            recentConversationCount: recentConversationMessages.length,
            routingAction,
            dataNeeds: {
                memory: requiresLongTermMemory,
                vision: visionPlan?.needed === true,
                deviceState: intention.dataPlan?.deviceState?.needed === true,
                toolsOrMCP: requiresToolsOrMCP,
                safety: intention.dataPlan?.safety,
            },
        });
        if (routingAction === 'ignore' || !intention.shouldRespond) {
            return {
                text: '',
                shouldRespond: false,
                shouldEndSession: intention.shouldEndSession,
                shouldRemember: false,
            };
        }
        if (routingAction === 'end_session' || intention.shouldEndSession) {
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
                        traceModelDecision('Brain', 'rag_fetch_complete', {
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
                    startedAt: toolFetchStartedAt,
                })
                : Promise.resolve(undefined),
        ]);
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

        traceModelDecision('Brain', 'response_context', {
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

        const responseText = await this.generateResponseText(
            conversationMessages,
            language,
            deps,
        );
        traceModelDecision('Brain', 'response_raw_output', responseText);

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
        traceModelDecision('Vision', 'request', {
            userCommand,
            detectorReference,
            prompt,
            imageBytes: preparedImage.length,
        });

        const result = await generate({
            model: visionModel as any,
            maxTokens: GLOBAL_CONFIG.OLLAMA.VISION_MAX_TOKENS,
            temperature: GLOBAL_CONFIG.OLLAMA.VISION_TEMPERATURE,
            messages: [
                {
                    role: 'user',
                    content: buildUserContent(prompt, preparedImage),
                },
            ] satisfies CoreMessage[],
        });
        traceModelDecision('Vision', 'summary_raw_output', result.text);

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
        startedAt: number;
    }): Promise<{ visualSummary?: string }> {
        const visualSummary = input.needsVision
            ? await this.describeVision(
                input.responseCommand,
                input.language,
                input.image,
                input.cameraContext,
                input.generate,
            )
            : undefined;

        traceModelDecision('Brain', 'tool_or_mcp_fetch_complete', {
            traceId: input.traceId,
            durationMs: Date.now() - input.startedAt,
            vision: Boolean(visualSummary),
        });

        return { visualSummary };
    }

    private async generateResponseText(
        messages: CoreMessage[],
        language: AssistantLanguage,
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
        const result = await stream(options);
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
    traceModelDecision('MemoryPrune', 'request', {
        messageCount: messages.length,
        purpose: purpose ?? 'long_term_lifestyle',
        instruction: effectiveInstruction,
        prompt,
    });

    const result = await generateText({
        model: textModel as any,
        maxTokens: GLOBAL_CONFIG.OLLAMA.TEXT_MAX_TOKENS,
        temperature: GLOBAL_CONFIG.OLLAMA.TEXT_TEMPERATURE,
        topP: GLOBAL_CONFIG.OLLAMA.TEXT_TOP_P,
        system: getMemoryPruneSystemPrompt(language),
        prompt,
    });
    traceModelDecision('MemoryPrune', 'draft_raw_output', result.text);

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
