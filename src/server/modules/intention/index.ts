import { createOllama } from 'ollama-ai-provider';
import { generateText, type CoreMessage } from 'ai';
import { GLOBAL_CONFIG } from '@/global_config';
import type { AssistantLanguage } from '@tools/Socket';
import type { ConversationMessage } from '@modules/memory';
import { buildIntentionUserPrompt, getIntentionSystemPrompt } from '@server/prompts';

export type UserIntent =
    | 'qa'
    | 'follow_up'
    | 'memory_recall'
    | 'visual'
    | 'device_control'
    | 'chitchat'
    | 'conversation_end'
    | 'acknowledgement'
    | 'non_actionable';
export type DialogueAct = 'new_request' | 'follow_up' | 'answer_to_assistant' | 'closing' | 'noise';
export type MemoryRetrievalMode = 'semantic' | 'recent_recall' | 'hybrid' | 'none';
export type MemoryTimeScope = 'recent' | 'all' | 'unspecified';

export interface IntentionAnalysis {
    intent: UserIntent;
    dialogueAct: DialogueAct;
    shouldRespond: boolean;
    shouldEndSession: boolean;
    visualUnderstanding: {
        required: boolean;
        reason: string;
    };
    memoryRetrieval: {
        enabled: boolean;
        mode: MemoryRetrievalMode;
        query: string;
        topics: string[];
        timeScope: MemoryTimeScope;
        confidence: number;
        reason: string;
    };
    resolvedContext: {
        isFollowUp: boolean;
        topic: string;
        rewrite: string;
    };
}

export interface AnalyzeCommandInput {
    userCommand: string;
    language?: AssistantLanguage;
    recentConversationMessages?: ConversationMessage[];
}

type GenerateTextLike = typeof generateText;
type PartialVisualUnderstanding = Partial<IntentionAnalysis['visualUnderstanding']>;
type PartialMemoryRetrieval = Partial<IntentionAnalysis['memoryRetrieval']>;
type PartialResolvedContext = Partial<IntentionAnalysis['resolvedContext']>;
type ValidationResult =
    | { ok: true; data: Partial<IntentionAnalysis> }
    | { ok: false; errors: string[] };

const ollama = createOllama({
    baseURL: GLOBAL_CONFIG.OLLAMA.IP,
});

const textModel = ollama(GLOBAL_CONFIG.OLLAMA.TEXT_MODEL, {
    numCtx: GLOBAL_CONFIG.OLLAMA.TEXT_NUM_CTX,
});

const INTENTS: UserIntent[] = ['qa', 'follow_up', 'memory_recall', 'visual', 'device_control', 'chitchat', 'conversation_end', 'acknowledgement', 'non_actionable'];
const DIALOGUE_ACTS: DialogueAct[] = ['new_request', 'follow_up', 'answer_to_assistant', 'closing', 'noise'];
const MEMORY_MODES: MemoryRetrievalMode[] = ['semantic', 'recent_recall', 'hybrid', 'none'];
const TIME_SCOPES: MemoryTimeScope[] = ['recent', 'all', 'unspecified'];

export async function analyzeCommand(
    input: AnalyzeCommandInput,
    deps: { generateText?: GenerateTextLike } = {},
): Promise<IntentionAnalysis> {
    const command = input.userCommand.trim();
    if (!command) {
        const empty = createAnalysis('non_actionable', 'noise', false, true, false, 'empty command has no visual request', false, 'none', '', [], 'unspecified', 0.95, 'empty command', false, '', '');
        traceIntention(command, empty, 'fallback');
        return empty;
    }

    try {
        const generate = deps.generateText ?? generateText;
        const messages = buildAnalysisMessages(input);
        const result = await generate({
            model: textModel as any,
            maxTokens: 320,
            temperature: 0,
            messages,
        });
        const parsed = await parseOrRepairIntentionAnalysis(result.text, command, messages, generate);
        traceIntention(command, parsed, 'model');
        return parsed;
    } catch (error) {
        const fallback = analyzeByFallback(input, 'model_error');
        console.log(`[Intention] fallback=model_error detail=${error instanceof Error ? error.message : String(error)}`);
        traceIntention(command, fallback, 'fallback');
        return fallback;
    }
}

export function parseIntentionAnalysis(raw: string, fallbackQuery: string): IntentionAnalysis {
    const validation = validateIntentionAnalysis(raw);
    if (validation.ok) {
        const data = validation.data;
        return normalizeAnalysis(data, fallbackQuery);
    }
    return createFallbackAnalysis(fallbackQuery, validation.errors.join('; '));
}

function analyzeByFallback(input: AnalyzeCommandInput, reason: string): IntentionAnalysis {
    const command = input.userCommand.trim();
    const contextTopic = inferRecentTopic(input.recentConversationMessages ?? []);
    if (contextTopic && isShortAmbiguousCommand(command)) {
        const rewrite = `${contextTopic} ${command}`;
        console.log(`[Intention] fallback=${reason} strategy=recent_context_rewrite`);
        return createAnalysis('follow_up', 'follow_up', true, false, false, 'fallback cannot safely infer visual need', true, 'semantic', rewrite, [], 'unspecified', 0.55, 'fallback short follow-up uses recent conversation context', true, contextTopic, rewrite);
    }

    console.log(`[Intention] fallback=${reason} strategy=semantic_original`);
    return createAnalysis('qa', 'new_request', true, false, false, 'fallback cannot safely infer visual need', true, 'semantic', command, [], 'unspecified', 0.55, 'fallback semantic retrieval for user command', false, '', command);
}

function buildAnalysisMessages(input: AnalyzeCommandInput): CoreMessage[] {
    const recentMessages = (input.recentConversationMessages ?? [])
        .slice(-6)
        .map(message => `${message.role === 'agent' ? 'Agent' : 'User'}: ${message.content}`)
        .join('\n');

    return [
        { role: 'system', content: getIntentionSystemPrompt(input.language) },
        {
            role: 'user',
            content: buildIntentionUserPrompt({
                userCommand: input.userCommand,
                recentConversationText: recentMessages,
            }),
        },
    ];
}

async function parseOrRepairIntentionAnalysis(
    raw: string,
    fallbackQuery: string,
    messages: CoreMessage[],
    generate: GenerateTextLike,
): Promise<IntentionAnalysis> {
    const validation = validateIntentionAnalysis(raw);
    if (validation.ok) {
        return normalizeAnalysis(validation.data, fallbackQuery);
    }

    console.log(`[Intention] model_output_invalid errors=${validation.errors.join('; ')}`);
    try {
        const repair = await generate({
            model: textModel as any,
            maxTokens: 320,
            temperature: 0,
            messages: [
                ...messages,
                { role: 'assistant', content: raw },
                {
                    role: 'user',
                    content: buildFormatRepairPrompt(validation.errors),
                },
            ],
        });
        const repairedValidation = validateIntentionAnalysis(repair.text);
        if (repairedValidation.ok) {
            return normalizeAnalysis(repairedValidation.data, fallbackQuery);
        }
        console.log(`[Intention] model_repair_invalid errors=${repairedValidation.errors.join('; ')}`);
        return createFallbackAnalysis(fallbackQuery, repairedValidation.errors.join('; '));
    } catch (error) {
        console.log(`[Intention] model_repair_error detail=${error instanceof Error ? error.message : String(error)}`);
        return createFallbackAnalysis(fallbackQuery, validation.errors.join('; '));
    }
}

function buildFormatRepairPrompt(errors: string[]): string {
    return `Your previous intent analysis output did not match the required JSON format.
Format errors:
- ${errors.join('\n- ')}

Check the output and return only one strict JSON object with all required fields and valid enum values. Do not explain.`;
}

function validateIntentionAnalysis(raw: string): ValidationResult {
    const jsonText = extractJsonText(raw);
    let data: unknown;
    try {
        data = JSON.parse(jsonText);
    } catch {
        return { ok: false, errors: ['invalid_json'] };
    }

    if (!isRecord(data)) {
        return { ok: false, errors: ['root must be a JSON object'] };
    }

    const errors: string[] = [];
    requireEnum(data, 'intent', INTENTS, errors);
    requireEnum(data, 'dialogueAct', DIALOGUE_ACTS, errors);
    requireBoolean(data, 'shouldRespond', errors);
    requireBoolean(data, 'shouldEndSession', errors);

    const visualUnderstanding = data.visualUnderstanding;
    if (visualUnderstanding !== undefined) {
        if (!isRecord(visualUnderstanding)) {
            errors.push('visualUnderstanding must be an object');
        } else {
            requireBoolean(visualUnderstanding, 'required', errors, 'visualUnderstanding');
            requireString(visualUnderstanding, 'reason', errors, 'visualUnderstanding');
        }
    }

    const memoryRetrieval = data.memoryRetrieval;
    if (!isRecord(memoryRetrieval)) {
        errors.push('memoryRetrieval must be an object');
    } else {
        requireBoolean(memoryRetrieval, 'enabled', errors, 'memoryRetrieval');
        requireEnum(memoryRetrieval, 'mode', MEMORY_MODES, errors, 'memoryRetrieval');
        requireString(memoryRetrieval, 'query', errors, 'memoryRetrieval');
        requireStringArray(memoryRetrieval, 'topics', errors, 'memoryRetrieval');
        requireEnum(memoryRetrieval, 'timeScope', TIME_SCOPES, errors, 'memoryRetrieval');
        requireNumber(memoryRetrieval, 'confidence', errors, 'memoryRetrieval');
        requireString(memoryRetrieval, 'reason', errors, 'memoryRetrieval');
    }

    const resolvedContext = data.resolvedContext;
    if (!isRecord(resolvedContext)) {
        errors.push('resolvedContext must be an object');
    } else {
        requireBoolean(resolvedContext, 'isFollowUp', errors, 'resolvedContext');
        requireString(resolvedContext, 'topic', errors, 'resolvedContext');
        requireString(resolvedContext, 'rewrite', errors, 'resolvedContext');
    }

    return errors.length > 0
        ? { ok: false, errors }
        : { ok: true, data: data as Partial<IntentionAnalysis> };
}

function normalizeAnalysis(data: Partial<IntentionAnalysis>, fallbackQuery: string): IntentionAnalysis {
    const intent = INTENTS.includes(data.intent as UserIntent) ? data.intent as UserIntent : 'qa';
    const dialogueAct = DIALOGUE_ACTS.includes(data.dialogueAct as DialogueAct)
        ? data.dialogueAct as DialogueAct
        : (intent === 'follow_up' ? 'follow_up' : 'new_request');
    const shouldRespond = data.shouldRespond !== false;
    const shouldEndSession = data.shouldEndSession === true || intent === 'conversation_end';
    const visual: PartialVisualUnderstanding = data.visualUnderstanding ?? {};
    const visualRequired = shouldRespond
        && !shouldEndSession
        && (intent === 'visual' || visual.required === true);
    const visualReason = stringValue(visual.reason)
        || (visualRequired ? '用户请求理解当前摄像头或图像内容' : '当前请求不需要视觉理解');
    const retrieval: PartialMemoryRetrieval = data.memoryRetrieval ?? {};
    const mode = MEMORY_MODES.includes(retrieval.mode as MemoryRetrievalMode)
        ? retrieval.mode as MemoryRetrievalMode
        : 'semantic';
    const timeScope = TIME_SCOPES.includes(retrieval.timeScope as MemoryTimeScope)
        ? retrieval.timeScope as MemoryTimeScope
        : 'unspecified';
    const confidence = clampNumber(retrieval.confidence, 0, 1, 0.55);
    const enabled = mode !== 'none' && retrieval.enabled !== false && confidence >= 0.55;
    const query = typeof retrieval.query === 'string' && retrieval.query.trim()
        ? retrieval.query.trim()
        : fallbackQuery;
    const topics = Array.isArray(retrieval.topics)
        ? retrieval.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0).map(topic => topic.trim()).slice(0, 5)
        : [];
    const reason = stringValue(retrieval.reason);
    const resolvedContext: PartialResolvedContext = data.resolvedContext ?? {};

    if (intent === 'memory_recall') {
        return createAnalysis(
            intent,
            dialogueAct,
            shouldRespond,
            shouldEndSession,
            visualRequired,
            visualReason,
            true,
            'recent_recall',
            query || fallbackQuery,
            topics,
            timeScope === 'unspecified' ? 'recent' : timeScope,
            Math.max(confidence, 0.55),
            reason || '用户请求回顾长期记忆或最近对话主题',
            Boolean(resolvedContext.isFollowUp),
            stringValue(resolvedContext.topic),
            stringValue(resolvedContext.rewrite),
        );
    }

    if (!enabled) {
        return createAnalysis(intent, dialogueAct, shouldRespond, shouldEndSession, visualRequired, visualReason, false, 'none', '', topics, timeScope, confidence, reason, Boolean(resolvedContext.isFollowUp), stringValue(resolvedContext.topic), stringValue(resolvedContext.rewrite));
    }

    return createAnalysis(
        intent,
        dialogueAct,
        shouldRespond,
        shouldEndSession,
        visualRequired,
        visualReason,
        true,
        mode,
        query,
        topics,
        timeScope,
        confidence,
        reason,
        Boolean(resolvedContext.isFollowUp),
        stringValue(resolvedContext.topic),
        stringValue(resolvedContext.rewrite),
    );
}

function createFallbackAnalysis(query: string, reason: string): IntentionAnalysis {
    console.log(`[Intention] fallback=${reason}`);
    return createAnalysis('qa', 'new_request', true, false, false, 'fallback cannot safely infer visual need', true, 'semantic', query, [], 'unspecified', 0.55, reason, false, '', query);
}

function createAnalysis(
    intent: UserIntent,
    dialogueAct: DialogueAct,
    shouldRespond: boolean,
    shouldEndSession: boolean,
    visualRequired: boolean,
    visualReason: string,
    enabled: boolean,
    mode: MemoryRetrievalMode,
    query: string,
    topics: string[],
    timeScope: MemoryTimeScope,
    confidence: number,
    reason: string,
    isFollowUp: boolean,
    topic: string,
    rewrite: string,
): IntentionAnalysis {
    return {
        intent,
        dialogueAct,
        shouldRespond,
        shouldEndSession,
        visualUnderstanding: {
            required: visualRequired,
            reason: visualReason,
        },
        memoryRetrieval: {
            enabled,
            mode,
            query,
            topics,
            timeScope,
            confidence,
            reason,
        },
        resolvedContext: {
            isFollowUp,
            topic,
            rewrite,
        },
    };
}

function inferRecentTopic(messages: ConversationMessage[]): string {
    const lastUserMessage = [...messages].reverse().find(message => message.role === 'user' && message.content.trim());
    return lastUserMessage?.content.trim() ?? '';
}

function isShortAmbiguousCommand(command: string): boolean {
    const normalized = command.trim();
    if (!normalized) return false;
    return Array.from(normalized).length <= 14;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function extractJsonText(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced?.[1]?.trim() ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldName(prefix: string | undefined, field: string): string {
    return prefix ? `${prefix}.${field}` : field;
}

function requireBoolean(data: Record<string, unknown>, field: string, errors: string[], prefix?: string): void {
    if (typeof data[field] !== 'boolean') {
        errors.push(`${fieldName(prefix, field)} must be a boolean`);
    }
}

function requireString(data: Record<string, unknown>, field: string, errors: string[], prefix?: string): void {
    if (typeof data[field] !== 'string') {
        errors.push(`${fieldName(prefix, field)} must be a string`);
    }
}

function requireNumber(data: Record<string, unknown>, field: string, errors: string[], prefix?: string): void {
    if (typeof data[field] !== 'number' || !Number.isFinite(data[field])) {
        errors.push(`${fieldName(prefix, field)} must be a finite number`);
    }
}

function requireStringArray(data: Record<string, unknown>, field: string, errors: string[], prefix?: string): void {
    const value = data[field];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        errors.push(`${fieldName(prefix, field)} must be an array of strings`);
    }
}

function requireEnum<T extends string>(data: Record<string, unknown>, field: string, allowed: readonly T[], errors: string[], prefix?: string): void {
    if (!allowed.includes(data[field] as T)) {
        errors.push(`${fieldName(prefix, field)} must be one of: ${allowed.join(', ')}`);
    }
}

function traceIntention(command: string, analysis: IntentionAnalysis, source: 'model' | 'fallback'): void {
    console.log(
        `[Intention] source=${source} command="${command}" intent=${analysis.intent} dialogueAct=${analysis.dialogueAct} shouldRespond=${analysis.shouldRespond} shouldEndSession=${analysis.shouldEndSession} visionRequired=${analysis.visualUnderstanding.required} visionReason="${analysis.visualUnderstanding.reason}" memoryEnabled=${analysis.memoryRetrieval.enabled} mode=${analysis.memoryRetrieval.mode} query="${analysis.memoryRetrieval.query}" confidence=${analysis.memoryRetrieval.confidence} reason="${analysis.memoryRetrieval.reason}"`,
    );
}
