import type { CoreMessage } from 'ai';
import { z } from 'zod';
import { GLOBAL_CONFIG } from '@/global_config';
import type { AssistantLanguage } from '@tools/Socket';
import type { ConversationMessage } from '@modules/memory';
import { routerRuleProfile, scoreCandidate, type ScoringResult } from '@modules/scoring';
import { buildIntentionUserPrompt, getIntentionSystemPrompt } from '@server/prompts';
import { recordModelDecision } from '@server/observability/modelTrace';
import { generateTextWithRuntimeLog } from '@server/observability/modelRuntime';
import { pipelineLogs } from '@server/services/PipelineLogService';
import { mlxModelClient } from '@server/services/model-runtime/MlxModelClient';

export const UserIntentSchema = z.enum([
    'qa',
    'follow_up',
    'memory_recall',
    'visual',
    'device_control',
    'chitchat',
    'conversation_end',
    'acknowledgement',
    'non_actionable',
]);
export type UserIntent = z.infer<typeof UserIntentSchema>;

export const DialogueActSchema = z.enum([
    'new_request',
    'follow_up',
    'answer_to_assistant',
    'closing',
    'noise',
]);
export type DialogueAct = z.infer<typeof DialogueActSchema>;

export const MemoryRetrievalModeSchema = z.enum(['semantic', 'recent_recall', 'hybrid', 'none']);
export type MemoryRetrievalMode = z.infer<typeof MemoryRetrievalModeSchema>;
export const MemoryTimeScopeSchema = z.enum(['recent', 'all', 'unspecified']);
export type MemoryTimeScope = z.infer<typeof MemoryTimeScopeSchema>;

export const RoutingActionSchema = z.enum([
    'ignore',
    'end_session',
    'direct_answer',
    'execute_device',
    'answer_after_context',
    'ask_clarification',
    'refuse',
]);
export type RoutingAction = z.infer<typeof RoutingActionSchema>;

export const SafetyRiskLevelSchema = z.enum(['none', 'privacy', 'device_risk', 'emergency']);
export type SafetyRiskLevel = z.infer<typeof SafetyRiskLevelSchema>;
export const ResponsePlanStyleSchema = z.enum(['brief_answer', 'brief_confirm', 'clarification_question', 'refusal']);
export type ResponsePlanStyle = z.infer<typeof ResponsePlanStyleSchema>;
export type RoutingDiagnosticSource = 'pre-router' | 'qwen-router' | 'fallback';

export const CoreRoutingDecisionSchema = z.object({
    traceId: z.string().min(1),
    intent: UserIntentSchema,
    dialogueAct: DialogueActSchema,
    routingAction: RoutingActionSchema,
    resolvedContext: z.object({
        isFollowUp: z.boolean(),
        topic: z.string(),
        rewriteQuery: z.string(),
    }),
    requiresLongTermMemory: z.boolean(),
    requiresToolsOrMCP: z.boolean(),
});
export type CoreRoutingDecision = z.infer<typeof CoreRoutingDecisionSchema>;

export interface IntentionAnalysis {
    traceId?: string;
    routingAction?: RoutingAction;
    requiresLongTermMemory?: boolean;
    requiresToolsOrMCP?: boolean;
    routingDiagnostics?: {
        source: RoutingDiagnosticSource;
        preRouterLayer?: PreRouterLayer;
        preRouterRule?: string;
        normalizedCommand?: string;
        modelSkipped: boolean;
        scoring?: ScoringResult;
    };
    routing?: {
        action: RoutingAction;
        confidence: number;
        reason: string;
    };
    contextResolution?: {
        isFollowUp: boolean;
        topic: string;
        responseRewrite: string;
        memoryQueryRewrite: string;
        currentSessionSufficient: boolean;
    };
    dataPlan?: {
        memory: {
            needed: boolean;
            mode: MemoryRetrievalMode;
            query: string;
            topics: string[];
            canFetchInParallel: boolean;
            reason: string;
            confidence: number;
        };
        vision: {
            needed: boolean;
            canFetchInParallel: boolean;
            reason: string;
        };
        deviceState: {
            needed: boolean;
            targets: string[];
            reason: string;
        };
        safety: {
            riskLevel: SafetyRiskLevel;
            requiresIdentity: boolean;
            requiresConfirmation: boolean;
            reason: string;
        };
    };
    responsePlan?: {
        style: ResponsePlanStyle;
        clarificationQuestion: string;
    };
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
        rewriteQuery?: string;
        rewrite: string;
    };
}

export interface AnalyzeCommandInput {
    userCommand: string;
    language?: AssistantLanguage;
    recentConversationMessages?: ConversationMessage[];
    traceId?: string;
    pipelineId?: string;
    conversationId?: string;
    benchmark?: unknown;
}

type GenerateTextLike = (options: any) => Promise<{ text: string }>;
type PartialVisualUnderstanding = Partial<IntentionAnalysis['visualUnderstanding']>;
type PartialMemoryRetrieval = Partial<IntentionAnalysis['memoryRetrieval']>;
type PartialResolvedContext = Partial<IntentionAnalysis['resolvedContext']>;
type PartialRouting = Partial<IntentionAnalysis['routing']>;
type PartialContextResolution = Partial<IntentionAnalysis['contextResolution']>;
type PartialDataPlan = Partial<IntentionAnalysis['dataPlan']>;
type PartialResponsePlan = Partial<IntentionAnalysis['responsePlan']>;
type ValidationResult =
    | { ok: true; data: Partial<IntentionAnalysis> }
    | { ok: false; errors: string[] };
type CoreValidationResult =
    | { ok: true; data: CoreRoutingDecision }
    | { ok: false; errors: string[] };
export type PreRouterLayer = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';
const PreRouterLayerValues: PreRouterLayer[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
type PreRouterMeta = {
    layer: PreRouterLayer;
    rule: string;
    normalizedCommand: string;
    routingReason: string;
    memoryReason: string;
    visualReason: string;
    confidence: number;
    safetyRiskLevel?: SafetyRiskLevel;
    safetyReason?: string;
    clarificationQuestion?: string;
};
type PreRouterDecision = {
    decision: CoreRoutingDecision;
    meta: PreRouterMeta;
};
type PreRouterTraceCheck = {
    layer: PreRouterLayer;
    rule: string;
    matched: boolean;
    durationMs: number;
    reason?: string;
};
type PreRouterTrace = {
    startedAt: number;
    normalizedCommand: string;
    checks: PreRouterTraceCheck[];
};
type PreRouterTraceOutcome = 'matched' | 'missed' | 'skipped_to_model';
type RoutingDiagnostics = NonNullable<IntentionAnalysis['routingDiagnostics']>;
type DeviceRisk = 'safe' | 'ambiguous' | 'high_risk';
type IntentionTraceContext = {
    pipelineId?: string;
    conversationId?: string;
    userCommand: string;
};

const defaultRoutingGenerate: GenerateTextLike = (options: any) => mlxModelClient.generateRoutingJson({
    role: 'fast',
    messages: options.messages ?? [],
    maxTokens: options.maxTokens,
    temperature: options.temperature,
});
const defaultRepairGenerate: GenerateTextLike = (options: any) => mlxModelClient.generateRoutingJson({
    role: 'repair',
    messages: options.messages ?? [],
    maxTokens: options.maxTokens,
    temperature: options.temperature,
});

const INTENTS = UserIntentSchema.options;
const DIALOGUE_ACTS = DialogueActSchema.options;
const MEMORY_MODES = MemoryRetrievalModeSchema.options;
const TIME_SCOPES = MemoryTimeScopeSchema.options;
const ROUTING_ACTIONS = RoutingActionSchema.options;
const SAFETY_RISK_LEVELS = SafetyRiskLevelSchema.options;
const RESPONSE_PLAN_STYLES = ResponsePlanStyleSchema.options;

const VisualUnderstandingValidationSchema = z.object({
    required: z.boolean(),
    reason: z.string(),
}).passthrough();

const MemoryRetrievalValidationSchema = z.object({
    enabled: z.boolean(),
    mode: MemoryRetrievalModeSchema,
    query: z.string(),
    topics: z.array(z.string()),
    timeScope: MemoryTimeScopeSchema,
    confidence: z.number().finite(),
    reason: z.string(),
}).passthrough();

const ResolvedContextValidationSchema = z.object({
    isFollowUp: z.boolean(),
    topic: z.string(),
    rewrite: z.string(),
}).passthrough();

const RoutingValidationSchema = z.object({
    action: RoutingActionSchema,
    confidence: z.number().finite(),
    reason: z.string(),
}).passthrough();

const ContextResolutionValidationSchema = z.object({
    isFollowUp: z.boolean(),
    topic: z.string(),
    responseRewrite: z.string(),
    memoryQueryRewrite: z.string(),
    currentSessionSufficient: z.boolean(),
}).passthrough();

const DataPlanValidationSchema = z.object({
    memory: z.object({
        needed: z.boolean(),
        mode: MemoryRetrievalModeSchema,
        query: z.string(),
        topics: z.array(z.string()),
        canFetchInParallel: z.boolean(),
        reason: z.string(),
        confidence: z.number().finite(),
    }).passthrough(),
    vision: z.object({
        needed: z.boolean(),
        canFetchInParallel: z.boolean(),
        reason: z.string(),
    }).passthrough(),
    deviceState: z.object({
        needed: z.boolean(),
        targets: z.array(z.string()),
        reason: z.string(),
    }).passthrough(),
    safety: z.object({
        riskLevel: SafetyRiskLevelSchema,
        requiresIdentity: z.boolean(),
        requiresConfirmation: z.boolean(),
        reason: z.string(),
    }).passthrough(),
}).passthrough();

const ResponsePlanValidationSchema = z.object({
    style: ResponsePlanStyleSchema,
    clarificationQuestion: z.string(),
}).passthrough();

const LayeredAnalysisValidationSchema = z.object({
    routing: RoutingValidationSchema,
    contextResolution: ContextResolutionValidationSchema,
    dataPlan: DataPlanValidationSchema,
    responsePlan: ResponsePlanValidationSchema,
    visualUnderstanding: VisualUnderstandingValidationSchema.optional(),
    memoryRetrieval: MemoryRetrievalValidationSchema.optional(),
    resolvedContext: ResolvedContextValidationSchema.optional(),
}).passthrough();


export async function analyzeCommand(
    input: AnalyzeCommandInput,
    deps: { generateText?: GenerateTextLike; repairGenerateText?: GenerateTextLike } = {},
): Promise<IntentionAnalysis> {
    const traceId = input.traceId || createTraceId();
    const command = input.userCommand.trim();
    const traceContext = buildIntentionTraceContext(input, command);

    const fastTrack = analyzeStaticFastTrack(command, traceId, input.recentConversationMessages ?? [], traceContext);
    if (fastTrack) {
        const routingDiagnostics = createPreRouterDiagnostics(fastTrack);
        logIntentionTrace({
            ...traceContext,
            traceId,
            stage: 'pre_router_hit',
            command,
            decision: fastTrack.decision,
            routerSource: routingDiagnostics.source,
            preRouterLayer: routingDiagnostics.preRouterLayer,
            preRouterRule: routingDiagnostics.preRouterRule,
            normalizedCommand: routingDiagnostics.normalizedCommand,
            modelSkipped: routingDiagnostics.modelSkipped,
        }, fastTrack.meta.safetyRiskLevel && fastTrack.meta.safetyRiskLevel !== 'none' ? 'warn' : 'info');
        const analysis = toCompatAnalysis(fastTrack.decision, {
            routingReason: fastTrack.meta.routingReason,
            memoryReason: fastTrack.meta.memoryReason,
            visualReason: fastTrack.meta.visualReason,
            confidence: fastTrack.meta.confidence,
            safetyRiskLevel: fastTrack.meta.safetyRiskLevel,
            safetyReason: fastTrack.meta.safetyReason,
            clarificationQuestion: fastTrack.meta.clarificationQuestion,
            routingDiagnostics,
        });
        traceIntention(command, analysis, 'pre-router', {
            preRouterLayer: routingDiagnostics.preRouterLayer,
            preRouterRule: routingDiagnostics.preRouterRule,
            normalizedCommand: routingDiagnostics.normalizedCommand,
            modelSkipped: routingDiagnostics.modelSkipped,
        });
        return analysis;
    }

    try {
        const generate = deps.generateText ?? defaultRoutingGenerate;
        const repairGenerate = deps.repairGenerateText ?? (deps.generateText ? generate : defaultRepairGenerate);
        const requestInput = { ...input, userCommand: command, traceId };
        const messages = buildCoreRoutingMessages(requestInput);
        const startedAt = Date.now();
        logIntentionTrace({
            ...traceContext,
            traceId,
            stage: 'core_routing_request',
            command,
            recentConversationCount: input.recentConversationMessages?.length ?? 0,
            messages,
        });
        const options = {
            maxTokens: GLOBAL_CONFIG.MODELS.INTENSION.MAX_TOKENS,
            temperature: 0,
            messages,
        };
        const result = generate === defaultRoutingGenerate
            ? await generateTextWithRuntimeLog(generate, options, {
                scope: 'intention.routing',
                modelId: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_FAST_MODEL_ID,
                traceId,
                pipelineId: input.pipelineId,
                conversationId: input.conversationId,
                userCommand: command,
                benchmark: input.benchmark,
            })
            : await generate(options);
        logIntentionTrace({
            ...traceContext,
            traceId,
            stage: 'core_routing_raw_output',
            command,
            durationMs: Date.now() - startedAt,
            rawOutput: result.text,
        });
        const parsed = await parseOrRepairCoreDecision({
            raw: result.text,
            input: requestInput,
            messages,
            generate,
            repairGenerate,
        });
        const guarded = applyDeterministicRoutingRules(parsed, command, requestInput);
        logIntentionTrace({
            ...traceContext,
            traceId,
            stage: 'core_routing_complete',
            command,
            decision: guarded,
        });
        const analysis = toCompatAnalysis(guarded, {
            routingReason: 'core routing decision',
            memoryReason: guarded.requiresLongTermMemory ? 'core routing requested long-term memory' : 'core routing did not request long-term memory',
            visualReason: guarded.requiresToolsOrMCP ? 'core routing requested tool, MCP, or visual context' : 'core routing did not request tool, MCP, or visual context',
            confidence: 0.86,
            routingDiagnostics: {
                source: 'qwen-router',
                modelSkipped: false,
            },
        });
        traceIntention(command, analysis, 'model');
        return analysis;
    } catch (error) {
        const fallback = analyzeByFallback({ ...input, traceId }, 'model_error');
        const detail = error instanceof Error ? error.message : String(error);
        console.log(`[Intention] fallback=model_error detail=${detail}`);
        pipelineLogs.recordIncident({
            pipelineId: input.pipelineId,
            conversationId: input.conversationId,
            stage: 'intent',
            reason: 'model_error',
            severity: 'warn',
            inputSnapshot: buildAnalysisMessages(input),
            outputSnapshot: detail,
            metadata: {
                traceId,
                userCommand: command,
                error: detail,
                fallback,
                recentConversationMessages: input.recentConversationMessages ?? [],
            },
        });
        traceIntention(command, fallback, 'fallback');
        return fallback;
    }
}

function buildIntentionTraceContext(input: AnalyzeCommandInput, command: string): IntentionTraceContext {
    return {
        pipelineId: input.pipelineId,
        conversationId: input.conversationId,
        userCommand: command || input.userCommand,
    };
}

function createPreRouterDiagnostics(fastTrack: PreRouterDecision): RoutingDiagnostics {
    return {
        source: 'pre-router',
        preRouterLayer: fastTrack.meta.layer,
        preRouterRule: fastTrack.meta.rule,
        normalizedCommand: fastTrack.meta.normalizedCommand,
        modelSkipped: true,
        scoring: fastTrack.meta.layer === 'P2' ? undefined : scorePreRouterDecision(fastTrack),
    };
}

function scorePreRouterDecision(fastTrack: PreRouterDecision): ScoringResult {
    return scoreCandidate({
        baseScore: 1,
        relevance: fastTrack.meta.confidence,
        confidence: fastTrack.meta.confidence,
        freshness: { score: routerRuleProfile.freshness.unknownScore },
        feedback: {},
        situation: fastTrack.decision.requiresLongTermMemory || fastTrack.decision.requiresToolsOrMCP ? 0.8 : 0.5,
        exploration: { impressions: 0 },
    }, routerRuleProfile);
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
    const normalized = normalizeCommand(command);
    const contextTopic = inferRecentAssistantTopic(input.recentConversationMessages ?? []);
    if (contextTopic && isExplicitShortFollowUp(normalized)) {
        const rewrite = `${contextTopic} ${command}`;
        console.log(`[Intention] fallback=${reason} strategy=recent_context_rewrite`);
        return createAnalysis({
            traceId: input.traceId,
            intent: 'follow_up',
            dialogueAct: 'follow_up',
            shouldRespond: true,
            shouldEndSession: false,
            visualRequired: false,
            visualReason: 'fallback cannot safely infer visual need',
            memoryEnabled: false,
            memoryMode: 'none',
            memoryQuery: rewrite,
            topics: [],
            timeScope: 'unspecified',
            memoryConfidence: 0.5,
            memoryReason: 'fallback uses current session context only',
            isFollowUp: true,
            topic: contextTopic,
            rewrite,
            routingAction: 'direct_answer',
            routingReason: 'fallback rewrote short follow-up from recent session context',
            currentSessionSufficient: true,
            responseStyle: 'brief_answer',
            routingDiagnostics: {
                source: 'fallback',
                modelSkipped: false,
            },
        });
    }

    console.log(`[Intention] fallback=${reason} strategy=semantic_original`);
    return createAnalysis({
        traceId: input.traceId,
        intent: 'qa',
        dialogueAct: 'new_request',
        shouldRespond: true,
        shouldEndSession: false,
        visualRequired: false,
        visualReason: 'fallback cannot safely infer visual need',
        memoryEnabled: false,
        memoryMode: 'none',
        memoryQuery: command,
        topics: [],
        timeScope: 'unspecified',
        memoryConfidence: 0.5,
        memoryReason: 'fallback direct answer avoids unnecessary long-term memory',
        isFollowUp: false,
        topic: '',
        rewrite: command,
        routingAction: 'direct_answer',
        routingReason: 'fallback direct answer for ordinary user command',
        currentSessionSufficient: true,
        responseStyle: 'brief_answer',
        routingDiagnostics: {
            source: 'fallback',
            modelSkipped: false,
        },
    });
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

function nowMs(): number {
    return globalThis.performance?.now?.() ?? Date.now();
}

function roundDurationMs(durationMs: number): number {
    return Math.max(0, Math.round(durationMs * 1000) / 1000);
}

function isPreRouterDecision(value: unknown): value is PreRouterDecision {
    return value !== null
        && typeof value === 'object'
        && 'decision' in value
        && 'meta' in value;
}

function describePreRouterCheckResult(result: unknown): string | undefined {
    if (isPreRouterDecision(result)) return result.meta.routingReason;
    if (result === true) return 'pre-router skipped multi-intent command to model router';
    return undefined;
}

function createPreRouterTrace(command: string): PreRouterTrace {
    return {
        startedAt: nowMs(),
        normalizedCommand: normalizeCommand(command),
        checks: [],
    };
}

function recordPreRouterCheck<T>(
    trace: PreRouterTrace,
    layer: PreRouterLayer,
    rule: string,
    check: () => T,
): T {
    const startedAt = nowMs();
    const result = check();
    const durationMs = roundDurationMs(nowMs() - startedAt);
    const reason = describePreRouterCheckResult(result);
    trace.checks.push({
        layer,
        rule,
        matched: Boolean(result),
        durationMs,
        ...(reason ? { reason } : {}),
    });
    return result;
}

function preRouterMatchedLayer(matched?: PreRouterDecision | { layer: PreRouterLayer; rule: string; reason: string }): PreRouterLayer | null {
    if (!matched) return null;
    return isPreRouterDecision(matched) ? matched.meta.layer : matched.layer;
}

function preRouterMatchedRule(matched?: PreRouterDecision | { layer: PreRouterLayer; rule: string; reason: string }): string | null {
    if (!matched) return null;
    return isPreRouterDecision(matched) ? matched.meta.rule : matched.rule;
}

function preRouterMatchedReason(matched?: PreRouterDecision | { layer: PreRouterLayer; rule: string; reason: string }): string | undefined {
    if (!matched) return undefined;
    return isPreRouterDecision(matched) ? matched.meta.routingReason : matched.reason;
}

function recordPreRouterPipelineEvent(
    traceContext: IntentionTraceContext | undefined,
    traceId: string,
    command: string,
    trace: PreRouterTrace,
    outcome: PreRouterTraceOutcome,
    matched?: PreRouterDecision | { layer: PreRouterLayer; rule: string; reason: string },
): void {
    if (!traceContext?.pipelineId && !traceContext?.conversationId) return;

    const matchedLayer = preRouterMatchedLayer(matched);
    const matchedRule = preRouterMatchedRule(matched);
    const matchedReason = preRouterMatchedReason(matched);
    const totalDurationMs = roundDurationMs(nowMs() - trace.startedAt);
    const timings = [
        ...trace.checks.map(check => ({
            key: `pre_router_${check.layer}_${check.rule}`,
            label: `${check.layer} ${check.rule}`,
            durationMs: check.durationMs,
            detail: check.matched ? 'matched' : 'missed',
        })),
        {
            key: 'pre_router_total',
            label: 'Pre-router total',
            durationMs: totalDurationMs,
            detail: outcome,
        },
    ];

    pipelineLogs.appendEvent({
        pipelineId: traceContext.pipelineId,
        conversationId: traceContext.conversationId,
        stage: 'intent',
        eventType: 'decision',
        level: 'info',
        title: 'pre_router.trace',
        message: matchedRule ? `${outcome}:${matchedRule}` : outcome,
        timings,
        metadata: {
            traceId,
            conversationId: traceContext.conversationId,
            pipelineId: traceContext.pipelineId,
            userCommand: command,
            normalizedCommand: trace.normalizedCommand,
            outcome,
            matchedLayer,
            matchedRule,
            matchedReason,
            modelSkipped: outcome === 'matched',
            totalDurationMs,
            checks: trace.checks,
        },
    });
}

function analyzeStaticFastTrack(
    command: string,
    traceId: string,
    recentMessages: ConversationMessage[] = [],
    traceContext?: IntentionTraceContext,
): PreRouterDecision | null {
    const trace = createPreRouterTrace(command);
    const normalized = trace.normalizedCommand;

    const emptyOrNoise = recordPreRouterCheck(trace, 'P0', 'empty_or_noise', () => {
        if (normalized) return null;
        return createPreRouterDecision({
            traceId,
            layer: 'P0',
            rule: 'empty_or_noise',
            normalizedCommand: normalized,
            intent: 'non_actionable',
            dialogueAct: 'noise',
            routingAction: 'ignore',
            topic: '',
            rewriteQuery: '',
            requiresLongTermMemory: false,
            requiresToolsOrMCP: false,
            routingReason: 'pre-router ignored empty or ASR noise input',
            memoryReason: 'empty or noise input does not need long-term memory',
            visualReason: 'empty or noise input does not need visual understanding',
            confidence: 0.99,
        });
    });
    if (emptyOrNoise) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', emptyOrNoise);
        return emptyOrNoise;
    }

    const sessionControl = recordPreRouterCheck(trace, 'P1', 'conversation_end', () => matchSessionControl(normalized, traceId));
    if (sessionControl) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', sessionControl);
        return sessionControl;
    }

    const highRisk = recordPreRouterCheck(trace, 'P2', 'high_risk_guard', () => matchHighRiskCommand(normalized, traceId));
    if (highRisk) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', highRisk);
        return highRisk;
    }

    const hasMultiIntent = recordPreRouterCheck(trace, 'P3', 'multi_intent_detected', () => hasMultipleIntentSegments(command));
    if (hasMultiIntent) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'skipped_to_model', {
            layer: 'P3',
            rule: 'multi_intent_detected',
            reason: 'pre-router skipped multi-intent command to model router',
        });
        logIntentionTrace({
            ...(traceContext ?? {}),
            traceId,
            stage: 'pre_router_skip',
            command,
            normalizedCommand: normalized,
            preRouterRule: 'multi_intent_detected',
            modelSkipped: false,
        });
        return null;
    }

    const device = recordPreRouterCheck(trace, 'P4', 'safe_device_control_placeholder', () => matchDeviceControl(normalized, traceId));
    if (device) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', device);
        return device;
    }

    const memoryRecall = recordPreRouterCheck(trace, 'P5', 'obvious_memory_recall', () => matchMemoryRecall(normalized, traceId));
    if (memoryRecall) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', memoryRecall);
        return memoryRecall;
    }

    const visualRequest = recordPreRouterCheck(trace, 'P5', 'obvious_visual_request', () => matchVisualRequest(normalized, traceId));
    if (visualRequest) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', visualRequest);
        return visualRequest;
    }

    const utility = recordPreRouterCheck(trace, 'P6', 'local_time_date_utility', () => matchUtility(normalized, traceId));
    if (utility) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', utility);
        return utility;
    }

    const followUp = recordPreRouterCheck(trace, 'P5', 'explicit_short_follow_up', () => matchShortFollowUp(normalized, traceId, recentMessages));
    if (followUp) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', followUp);
        return followUp;
    }

    const ordinaryQa = recordPreRouterCheck(trace, 'P7', 'strict_ordinary_qa', () => matchOrdinaryQa(normalized, traceId));
    if (ordinaryQa) {
        recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'matched', ordinaryQa);
        return ordinaryQa;
    }

    recordPreRouterPipelineEvent(traceContext, traceId, command, trace, 'missed');
    return null;
}

function createPreRouterDecision(input: {
    traceId: string;
    layer: PreRouterLayer;
    rule: string;
    normalizedCommand: string;
    intent: UserIntent;
    dialogueAct: DialogueAct;
    routingAction: RoutingAction;
    topic: string;
    rewriteQuery: string;
    requiresLongTermMemory: boolean;
    requiresToolsOrMCP: boolean;
    routingReason: string;
    memoryReason: string;
    visualReason: string;
    confidence: number;
    safetyRiskLevel?: SafetyRiskLevel;
    safetyReason?: string;
    clarificationQuestion?: string;
}): PreRouterDecision {
    return {
        decision: {
            traceId: input.traceId,
            intent: input.intent,
            dialogueAct: input.dialogueAct,
            routingAction: input.routingAction,
            resolvedContext: {
                isFollowUp: input.dialogueAct === 'follow_up',
                topic: input.topic,
                rewriteQuery: input.rewriteQuery,
            },
            requiresLongTermMemory: input.requiresLongTermMemory,
            requiresToolsOrMCP: input.requiresToolsOrMCP,
        },
        meta: {
            layer: input.layer,
            rule: input.rule,
            normalizedCommand: input.normalizedCommand,
            routingReason: input.routingReason,
            memoryReason: input.memoryReason,
            visualReason: input.visualReason,
            confidence: input.confidence,
            safetyRiskLevel: input.safetyRiskLevel,
            safetyReason: input.safetyReason,
            clarificationQuestion: input.clarificationQuestion,
        },
    };
}

function normalizeCommand(command: string): string {
    let normalized = command
        .toLowerCase()
        .replace(/[，。！？、,.!?;；:："'“”‘’（）()【】[\]{}<>《》]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const fillerPatterns = [
        /^(呃+|额+|嗯+|啊+|诶+|欸+|那个|这个|就是|那个就是|给我想想|先帮我想想|帮我看下先|帮我看一下先)\s*/u,
        /\s*(吧|呢|哈|呀|啊)$/u,
    ];

    let previous = '';
    while (previous !== normalized) {
        previous = normalized;
        for (const pattern of fillerPatterns) {
            normalized = normalized.replace(pattern, '').trim();
        }
    }

    return normalized.replace(/\s+/g, '');
}

function matchSessionControl(normalized: string, traceId: string): PreRouterDecision | null {
    const closingCommands = new Set([
        '再见',
        '拜拜',
        '白白',
        '结束',
        '没事了',
        '不用了',
        '就这样',
        'bye',
        'goodbye',
        'stop',
    ]);

    if (!closingCommands.has(normalized)) return null;

    return createPreRouterDecision({
        traceId,
        layer: 'P1',
        rule: 'conversation_end',
        normalizedCommand: normalized,
        intent: 'conversation_end',
        dialogueAct: 'closing',
        routingAction: 'end_session',
        topic: '对话结束',
        rewriteQuery: '',
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
        routingReason: 'pre-router matched an unambiguous session closing command',
        memoryReason: 'session closing does not need long-term memory',
        visualReason: 'session closing does not need visual understanding',
        confidence: 0.98,
    });
}

function matchHighRiskCommand(normalized: string, traceId: string): PreRouterDecision | null {
    const highRiskPatterns: Array<{ pattern: RegExp; risk: SafetyRiskLevel; reason: string }> = [
        { pattern: /(删除|清空|抹掉|擦除).*(记忆|数据|历史|记录)|清空记忆/u, risk: 'privacy', reason: '请求删除数据或清空记忆' },
        { pattern: /(重启|关闭|停止).*(服务|系统|设备|主机|电脑)|恢复出厂/u, risk: 'device_risk', reason: '请求重启、停止或恢复设备/服务' },
        { pattern: /(打开|开启|启动).*(摄像头|麦克风|话筒|录音|录像)/u, risk: 'privacy', reason: '请求打开隐私相关采集设备' },
        { pattern: /(关闭|禁用|修改).*(防火墙|安全|保护|权限)|安全设置/u, risk: 'device_risk', reason: '请求修改安全设置' },
        { pattern: /(开|打开|解锁|关闭|锁).*(门锁|门禁|安防|报警器)/u, risk: 'emergency', reason: '请求控制门锁或安防设备' },
    ];
    const matched = highRiskPatterns.find(item => item.pattern.test(normalized));
    if (!matched) return null;

    return createPreRouterDecision({
        traceId,
        layer: 'P2',
        rule: 'high_risk_guard',
        normalizedCommand: normalized,
        intent: 'device_control',
        dialogueAct: 'new_request',
        routingAction: 'ask_clarification',
        topic: '高风险操作确认',
        rewriteQuery: normalized,
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
        routingReason: `pre-router blocked high-risk command: ${matched.reason}`,
        memoryReason: 'high-risk guard does not need long-term memory',
        visualReason: 'high-risk guard does not need visual understanding',
        confidence: 0.97,
        safetyRiskLevel: matched.risk,
        safetyReason: matched.reason,
        clarificationQuestion: '这个操作可能影响隐私、安全或设备状态，请确认你希望继续吗？',
    });
}

function hasMultipleIntentSegments(command: string): boolean {
    const parts = command
        .split(/(?:顺便|然后|并且|另外|还有|接着|，|。|；|;)/u)
        .map(part => normalizeCommand(part))
        .filter(Boolean);

    if (parts.length < 2) return false;

    const categories = new Set(parts.map(classifySegmentIntent).filter(Boolean));
    return categories.size >= 2;
}

function classifySegmentIntent(normalized: string): string {
    if (!normalized) return '';
    if (/(再见|拜拜|白白|结束|不用了|没事了|就这样|bye|goodbye|stop)/u.test(normalized)) return 'session';
    if (classifyDeviceRisk(normalized) === 'safe') return 'device';
    if (isMemoryRecallCommand(normalized)) return 'memory';
    if (isVisualRequest(normalized)) return 'visual';
    if (isWeatherRequest(normalized)) return 'weather';
    if (isUtilityTimeRequest(normalized)) return 'utility';
    if (/(总结|查|查询|搜索|告诉我|怎么|如何|为什么|什么)/u.test(normalized)) return 'qa';
    return '';
}

function classifyDeviceRisk(normalized: string): DeviceRisk {
    if (/(门锁|门禁|安防|报警器|摄像头|麦克风|防火墙|安全设置|恢复出厂|重启|清空|删除)/u.test(normalized)) {
        return 'high_risk';
    }
    if (/(那个|这个|门口|客厅|卧室|厨房|书房|阳台|灯还亮|亮着|状态|怎么.*灯)/u.test(normalized)) {
        return 'ambiguous';
    }
    if (/^(开灯|打开灯|把灯打开|关灯|关闭灯|把灯关掉)$/u.test(normalized)) {
        return 'safe';
    }
    return /(灯|空调|窗帘|插座|电视)/u.test(normalized) ? 'ambiguous' : 'safe';
}

function matchDeviceControl(normalized: string, traceId: string): PreRouterDecision | null {
    if (classifyDeviceRisk(normalized) !== 'safe') return null;

    const safeDeviceCommands: Array<{ pattern: RegExp; rewrite: string; topic: string }> = [
        { pattern: /^(开灯|打开灯|把灯打开)$/u, rewrite: '打开灯', topic: '智能家居照明' },
        { pattern: /^(关灯|关闭灯|把灯关掉)$/u, rewrite: '关闭灯', topic: '智能家居照明' },
    ];
    const deviceMatch = safeDeviceCommands.find(item => item.pattern.test(normalized));
    if (!deviceMatch) return null;

    return createPreRouterDecision({
        traceId,
        layer: 'P4',
        rule: 'safe_device_control_placeholder',
        normalizedCommand: normalized,
        intent: 'device_control',
        dialogueAct: 'new_request',
        routingAction: 'execute_device',
        topic: deviceMatch.topic,
        rewriteQuery: deviceMatch.rewrite,
        requiresLongTermMemory: false,
        requiresToolsOrMCP: true,
        routingReason: 'pre-router matched a low-risk explicit lighting command',
        memoryReason: 'device control does not need long-term memory',
        visualReason: 'safe device command does not need visual understanding',
        confidence: 0.96,
    });
}

function matchMemoryRecall(normalized: string, traceId: string): PreRouterDecision | null {
    if (isMemoryRecallCommand(normalized)) {
        const rewriteQuery = normalizeMemoryRecallRewrite(normalized);
        return createPreRouterDecision({
            traceId,
            layer: 'P5',
            rule: 'obvious_memory_recall',
            normalizedCommand: normalized,
            intent: 'memory_recall',
            dialogueAct: 'new_request',
            routingAction: 'answer_after_context',
            topic: '长期记忆回顾',
            rewriteQuery,
            requiresLongTermMemory: true,
            requiresToolsOrMCP: false,
            routingReason: 'pre-router matched an obvious memory recall request',
            memoryReason: 'user asks to recall previous conversation or memory',
            visualReason: 'memory recall does not need visual understanding',
            confidence: 0.93,
        });
    }

    return null;
}

function matchVisualRequest(normalized: string, traceId: string): PreRouterDecision | null {
    if (isVisualRequest(normalized)) {
        return createPreRouterDecision({
            traceId,
            layer: 'P5',
            rule: 'obvious_visual_request',
            normalizedCommand: normalized,
            intent: 'visual',
            dialogueAct: 'new_request',
            routingAction: 'answer_after_context',
            topic: '视觉理解',
            rewriteQuery: normalized,
            requiresLongTermMemory: false,
            requiresToolsOrMCP: true,
            routingReason: 'pre-router matched an obvious current visual request',
            memoryReason: 'visual request does not need long-term memory by default',
            visualReason: 'user asks about current visual appearance or camera-visible scene',
            confidence: 0.92,
        });
    }

    return null;
}

function normalizeMemoryRecallRewrite(normalized: string): string {
    return normalized
        .replace(/^(帮我)?(总结一下|总结|回顾一下|回顾|告诉我|说说|讲讲)/u, '')
        .replace(/^(一下|下)/u, '')
        .trim() || normalized;
}

function matchUtility(normalized: string, traceId: string): PreRouterDecision | null {
    if (!isUtilityTimeRequest(normalized) || isWeatherRequest(normalized)) return null;

    return createPreRouterDecision({
        traceId,
        layer: 'P6',
        rule: 'local_time_date_utility',
        normalizedCommand: normalized,
        intent: 'qa',
        dialogueAct: 'new_request',
        routingAction: 'direct_answer',
        topic: '本地时间日期',
        rewriteQuery: normalized,
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
        routingReason: 'pre-router matched a local time/date utility request',
        memoryReason: 'local time/date utility does not need long-term memory',
        visualReason: 'local time/date utility does not need visual understanding',
        confidence: 0.94,
    });
}

function matchShortFollowUp(normalized: string, traceId: string, recentMessages: ConversationMessage[]): PreRouterDecision | null {
    const topic = inferRecentAssistantTopic(recentMessages);
    if (!topic || !isExplicitShortFollowUp(normalized)) return null;
    const rewrite = `${topic} ${normalized}`;

    return createPreRouterDecision({
        traceId,
        layer: 'P5',
        rule: 'explicit_short_follow_up',
        normalizedCommand: normalized,
        intent: 'follow_up',
        dialogueAct: 'follow_up',
        routingAction: 'direct_answer',
        topic,
        rewriteQuery: rewrite,
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
        routingReason: 'pre-router rewrote an explicit short follow-up from recent assistant context',
        memoryReason: 'explicit follow-up uses current session context only',
        visualReason: 'explicit follow-up does not need visual understanding',
        confidence: 0.82,
    });
}

function matchOrdinaryQa(normalized: string, traceId: string): PreRouterDecision | null {
    if (!isStrictOrdinaryQa(normalized)) return null;

    return createPreRouterDecision({
        traceId,
        layer: 'P7',
        rule: 'strict_ordinary_qa',
        normalizedCommand: normalized,
        intent: 'qa',
        dialogueAct: 'new_request',
        routingAction: 'direct_answer',
        topic: '',
        rewriteQuery: normalized,
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
        routingReason: 'pre-router matched a strict general-knowledge QA request',
        memoryReason: 'strict ordinary QA does not need long-term memory',
        visualReason: 'strict ordinary QA does not need visual understanding',
        confidence: 0.8,
    });
}

function isVisualRequest(normalized: string): boolean {
    return /(看看|看一下|看下|观察|识别|画面|镜头|照片|图片|穿的|衣服|我今天穿|长什么样|这边情况|眼前|摄像头).*(怎么样|是什么|有什么|好看|评价|情况)?/u.test(normalized)
        || /(如何|怎么).*(评价|看).*(穿的|衣服|照片|图片)/u.test(normalized);
}

function isWeatherRequest(normalized: string): boolean {
    return /(天气|下雨|气温|温度|空气质量|刮风|降温|升温|明天.*冷|今天.*热)/u.test(normalized);
}

function isUtilityTimeRequest(normalized: string): boolean {
    return /^(现在)?(几点|几时|什么时间|当前时间)$|^(今天|明天|昨天)?(星期几|周几|几号|日期)$|^今天是什么日子$/u.test(normalized);
}

function isExplicitShortFollowUp(normalized: string): boolean {
    return /^(继续说|展开讲|详细讲讲|再讲讲|为什么|怎么做|然后呢|还有呢|具体呢|举例呢|有什么需要注意的吗?|需要注意什么)$/u.test(normalized);
}

function isStrictOrdinaryQa(normalized: string): boolean {
    if (!/^(什么是|为什么|如何理解|请解释|解释一下|介绍一下|科普一下)/u.test(normalized)) return false;
    return !hasOrdinaryQaBlacklist(normalized);
}

function hasOrdinaryQaBlacklist(normalized: string): boolean {
    return /(灯|空调|窗帘|插座|电视|设备|门口|客厅|卧室|厨房|书房|阳台|这个|那个|这|那|它|他|她|画面|镜头|照片|图片|穿的|衣服|看看|看一下|记得|记忆|刚才|之前|最近|上次|天气|日程|顺便|然后|并且|另外|清空|删除|重启|摄像头|麦克风|防火墙|门锁|安防)/u.test(normalized);
}

function buildCoreRoutingMessages(input: AnalyzeCommandInput & { traceId: string }): CoreMessage[] {
    const recentMessages = (input.recentConversationMessages ?? [])
        .slice(-6)
        .map(message => `${message.role === 'agent' ? 'Agent' : 'User'}: ${message.content}`)
        .join('\n');
    const schemaExample: CoreRoutingDecision = {
        traceId: input.traceId,
        intent: 'qa',
        dialogueAct: 'new_request',
        routingAction: 'direct_answer',
        resolvedContext: {
            isFollowUp: false,
            topic: '',
            rewriteQuery: input.userCommand,
        },
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
    };

    return [
        {
            role: 'system',
            content: input.language === 'en'
                ? 'You are a fast routing classifier for a local home assistant. Return only strict JSON. Do not answer the user.'
                : '你是本地家庭助手的快速路由分类器。只输出严格 JSON，不要回答用户。',
        },
        {
            role: 'user',
            content: `Trace ID: ${input.traceId}
Command: ${input.userCommand}
Recent conversation:
${recentMessages || '(none)'}

Return one compact JSON object matching this exact TypeScript shape:
{
  "traceId": "same trace id",
  "intent": "qa | follow_up | memory_recall | visual | device_control | chitchat | conversation_end | acknowledgement | non_actionable",
  "dialogueAct": "new_request | follow_up | answer_to_assistant | closing | noise",
  "routingAction": "ignore | end_session | direct_answer | execute_device | answer_after_context | ask_clarification | refuse",
  "resolvedContext": {
    "isFollowUp": false,
    "topic": "",
    "rewriteQuery": "self-contained rewritten command"
  },
  "requiresLongTermMemory": false,
  "requiresToolsOrMCP": false
}

Rules:
- Keep the output small and valid JSON only.
- Use requiresLongTermMemory only when past user preferences, remembered facts, or explicit memory recall can change the answer.
- Use requiresToolsOrMCP for device control, current camera/visual inspection, hardware state, or MCP/tool state reads.
- High-risk, vague, or pronoun-based device controls should ask clarification instead of execute_device.
- If the command asks what we discussed before/recently, intent must be memory_recall and requiresLongTermMemory true.
- If the command is a pure acknowledgement or noise without a new request, use ignore and do not request memory/tools.
- For any route except ignore or end_session, resolvedContext.rewriteQuery must be non-empty.
- For follow-ups, rewriteQuery must include the recent topic, not just the short user phrase.
- Examples: if recent topic is 红烧牛肉 and command is "请告诉我详细的步骤。", use "请详细说明红烧牛肉的制作步骤"; if command is "准备的材料有什么要求吗？", use "红烧牛肉食材和材料准备有什么要求"; if command is "我们之前聊过什么话题？", use the command itself.

Example shape:
${JSON.stringify(schemaExample)}`,
        },
    ];
}

async function parseOrRepairCoreDecision(input: {
    raw: string;
    input: AnalyzeCommandInput & { traceId: string };
    messages: CoreMessage[];
    generate: GenerateTextLike;
    repairGenerate: GenerateTextLike;
}): Promise<CoreRoutingDecision> {
    const validation = validateCoreRoutingDecision(input.raw, input.input.traceId);
    if (validation.ok) {
        return validation.data;
    }

    logIntentionTrace({
        ...buildIntentionTraceContext(input.input, input.input.userCommand),
        traceId: input.input.traceId,
        stage: 'core_routing_parse_failed',
        command: input.input.userCommand,
        errors: validation.errors,
        rawOutput: input.raw,
    }, 'warn');

    try {
        logIntentionTrace({
            ...buildIntentionTraceContext(input.input, input.input.userCommand),
            traceId: input.input.traceId,
            stage: 'core_routing_repair_attempt',
            command: input.input.userCommand,
            errors: validation.errors,
        }, 'warn');
        const repairMessages: CoreMessage[] = [
            ...input.messages,
            { role: 'assistant', content: input.raw },
            {
                role: 'user',
                content: buildCoreFormatRepairPrompt(validation.errors, input.input.traceId),
            },
        ];
        const repairOptions = {
            maxTokens: GLOBAL_CONFIG.MODELS.INTENSION.MAX_TOKENS,
            temperature: 0,
            messages: repairMessages,
        };
        const repair = input.repairGenerate === defaultRepairGenerate
            ? await generateTextWithRuntimeLog(input.repairGenerate, repairOptions, {
                scope: 'intention.repair',
                modelId: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_REPAIR_MODEL_ID,
                traceId: input.input.traceId,
                pipelineId: input.input.pipelineId,
                conversationId: input.input.conversationId,
                userCommand: input.input.userCommand,
                benchmark: input.input.benchmark,
            })
            : await input.repairGenerate(repairOptions);
        const repairedValidation = validateCoreRoutingDecision(repair.text, input.input.traceId);
        if (repairedValidation.ok) {
            return repairedValidation.data;
        }
        logIntentionTrace({
            ...buildIntentionTraceContext(input.input, input.input.userCommand),
            traceId: input.input.traceId,
            stage: 'core_routing_repair_failed',
            command: input.input.userCommand,
            rawOutput: input.raw,
            repairOutput: repair.text,
            initialErrors: validation.errors,
            repairErrors: repairedValidation.errors,
        }, 'warn');
        return createFallbackCoreDecision(input.input, repairedValidation.errors.join('; '));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logIntentionTrace({
            ...buildIntentionTraceContext(input.input, input.input.userCommand),
            traceId: input.input.traceId,
            stage: 'core_routing_repair_failed',
            command: input.input.userCommand,
            rawOutput: input.raw,
            initialErrors: validation.errors,
            repairError: detail,
        }, 'error');
        return createFallbackCoreDecision(input.input, validation.errors.join('; '));
    }
}

function validateCoreRoutingDecision(raw: string, traceId: string): CoreValidationResult {
    let data: unknown;
    try {
        data = JSON.parse(extractJsonText(raw));
    } catch {
        return { ok: false, errors: ['invalid_json'] };
    }

    const parsed = CoreRoutingDecisionSchema.safeParse(data);
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`),
        };
    }

    return { ok: true, data: { ...parsed.data, traceId } };
}

function buildCoreFormatRepairPrompt(errors: string[], traceId: string): string {
    return `Your previous routing JSON failed validation.
Trace ID must be exactly: ${traceId}
Errors:
- ${errors.join('\n- ')}

Return only one strict JSON object with fields:
traceId, intent, dialogueAct, routingAction, resolvedContext.isFollowUp, resolvedContext.topic, resolvedContext.rewriteQuery, requiresLongTermMemory, requiresToolsOrMCP.
Do not include markdown or explanations.`;
}

function applyDeterministicRoutingRules(decision: CoreRoutingDecision, command: string, input: AnalyzeCommandInput & { traceId: string }): CoreRoutingDecision {
    let next = decision;
    const traceContext = buildIntentionTraceContext(input, command);
    const applyRule = (
        ruleName: string,
        patch: Partial<Omit<CoreRoutingDecision, 'resolvedContext'>> & {
            resolvedContext?: Partial<CoreRoutingDecision['resolvedContext']>;
        },
    ): void => {
        const before = next;
        next = {
            ...next,
            ...patch,
            resolvedContext: {
                ...next.resolvedContext,
                ...(patch.resolvedContext ?? {}),
            },
            traceId: input.traceId,
        };
        logIntentionTrace({
            ...traceContext,
            traceId: input.traceId,
            stage: 'deterministic_rule_applied',
            command,
            ruleName,
            before,
            after: next,
        }, 'warn');
    };

    if (next.intent === 'device_control' && (next.routingAction !== 'execute_device' || !next.requiresToolsOrMCP)) {
        applyRule('device_control_requires_tools', {
            routingAction: next.routingAction === 'ask_clarification' ? 'ask_clarification' : 'execute_device',
            requiresToolsOrMCP: true,
            requiresLongTermMemory: false,
        });
    }

    if (next.intent === 'memory_recall' && (!next.requiresLongTermMemory || next.routingAction !== 'answer_after_context')) {
        applyRule('memory_recall_requires_memory', {
            routingAction: 'answer_after_context',
            requiresLongTermMemory: true,
            requiresToolsOrMCP: false,
            resolvedContext: {
                rewriteQuery: next.resolvedContext.rewriteQuery || command,
            },
        });
    }

    if (isMemoryRecallCommand(command) && (!next.requiresLongTermMemory || next.routingAction === 'ask_clarification')) {
        applyRule('semantic_memory_recall_requires_memory', {
            intent: 'memory_recall',
            routingAction: 'answer_after_context',
            requiresLongTermMemory: true,
            requiresToolsOrMCP: false,
            resolvedContext: {
                topic: next.resolvedContext.topic || '长期记忆回顾',
                rewriteQuery: next.routingAction === 'ask_clarification'
                    ? command
                    : next.resolvedContext.rewriteQuery || command,
            },
        });
    }

    if (['ignore', 'end_session', 'refuse'].includes(next.routingAction)
        && (next.requiresLongTermMemory || next.requiresToolsOrMCP)) {
        applyRule('terminal_routes_disable_data_plane', {
            requiresLongTermMemory: false,
            requiresToolsOrMCP: false,
        });
    }

    if (!next.resolvedContext.rewriteQuery && next.routingAction !== 'ignore' && next.routingAction !== 'end_session') {
        applyRule('non_terminal_route_requires_rewrite', {
            resolvedContext: {
                rewriteQuery: command,
            },
        });
    }

    return next;
}

function createFallbackCoreDecision(input: AnalyzeCommandInput & { traceId: string }, reason: string): CoreRoutingDecision {
    const command = input.userCommand.trim();
    const normalized = normalizeCommand(command);
    const contextTopic = inferRecentAssistantTopic(input.recentConversationMessages ?? []);
    const canRewriteFollowUp = Boolean(contextTopic && isExplicitShortFollowUp(normalized));
    const rewriteQuery = canRewriteFollowUp
        ? `${contextTopic} ${command}`
        : command;
    const decision: CoreRoutingDecision = {
        traceId: input.traceId,
        intent: canRewriteFollowUp ? 'follow_up' : 'qa',
        dialogueAct: canRewriteFollowUp ? 'follow_up' : 'new_request',
        routingAction: 'direct_answer',
        resolvedContext: {
            isFollowUp: canRewriteFollowUp,
            topic: contextTopic,
            rewriteQuery,
        },
        requiresLongTermMemory: false,
        requiresToolsOrMCP: false,
    };
    logIntentionTrace({
        ...buildIntentionTraceContext(input, command),
        traceId: input.traceId,
        stage: 'core_routing_fallback',
        command,
        reason,
        decision,
    }, 'warn');
    return decision;
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
        const repairMessages: CoreMessage[] = [
            ...messages,
            { role: 'assistant', content: raw },
            {
                role: 'user',
                content: buildFormatRepairPrompt(validation.errors),
            },
        ];
        const repairOptions = {
            maxTokens: GLOBAL_CONFIG.MODELS.INTENSION.MAX_TOKENS,
            temperature: 0,
            messages: repairMessages,
        };
        const repair = generate === defaultRepairGenerate
            ? await generateTextWithRuntimeLog(generate, repairOptions, {
                scope: 'intention.repair',
                modelId: GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_REPAIR_MODEL_ID,
                userCommand: fallbackQuery,
            })
            : await generate(repairOptions);
        recordModelDecision('Intention', 'repair_raw_output', repair.text);
        const repairedValidation = validateIntentionAnalysis(repair.text);
        if (repairedValidation.ok) {
            return normalizeAnalysis(repairedValidation.data, fallbackQuery);
        }
        console.log(`[Intention] model_repair_invalid errors=${repairedValidation.errors.join('; ')}`);
        const fallback = createFallbackAnalysis(fallbackQuery, repairedValidation.errors.join('; '));
        pipelineLogs.recordIncident({
            stage: 'intent',
            reason: 'model_repair_invalid',
            severity: 'warn',
            inputSnapshot: messages,
            outputSnapshot: repair.text,
            metadata: {
                userCommand: fallbackQuery,
                rawOutput: raw,
                initialErrors: validation.errors,
                repairErrors: repairedValidation.errors,
                fallback,
            },
        });
        return fallback;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.log(`[Intention] model_repair_error detail=${detail}`);
        const fallback = createFallbackAnalysis(fallbackQuery, validation.errors.join('; '));
        pipelineLogs.recordIncident({
            stage: 'intent',
            reason: 'model_repair_error',
            severity: 'error',
            inputSnapshot: messages,
            outputSnapshot: detail,
            metadata: {
                userCommand: fallbackQuery,
                rawOutput: raw,
                initialErrors: validation.errors,
                fallback,
            },
        });
        return fallback;
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

    const parsed = LayeredAnalysisValidationSchema.safeParse(data);
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map(formatValidationIssue),
        };
    }

    return { ok: true, data: data as Partial<IntentionAnalysis> };
}

function formatValidationIssue(issue: z.ZodIssue): string {
    const path = issue.path.join('.') || 'root';
    switch (issue.code) {
        case z.ZodIssueCode.invalid_type:
            if (issue.received === 'undefined') return `${path} is required`;
            return `${path} must be ${issue.expected === 'array' ? 'an array' : issue.expected}`;
        case z.ZodIssueCode.invalid_enum_value:
            return `${path} must be one of: ${issue.options.join(', ')}`;
        case z.ZodIssueCode.too_small:
            if (issue.type === 'string') return `${path} must be a string`;
            if (issue.type === 'array') return `${path} must be an array of strings`;
            return `${path} is too small`;
        case z.ZodIssueCode.invalid_string:
            return `${path} must be a string`;
        default:
            return `${path}: ${issue.message}`;
    }
}

function normalizeAnalysis(data: Partial<IntentionAnalysis>, fallbackQuery: string): IntentionAnalysis {
    const routing: PartialRouting = data.routing ?? {};
    const contextResolution: PartialContextResolution = data.contextResolution ?? {};
    const dataPlan: PartialDataPlan = data.dataPlan ?? {};
    const layeredMemory: Partial<NonNullable<IntentionAnalysis['dataPlan']>['memory']> = dataPlan.memory ?? {};
    const layeredVision: Partial<NonNullable<IntentionAnalysis['dataPlan']>['vision']> = dataPlan.vision ?? {};
    const layeredDeviceState: Partial<NonNullable<IntentionAnalysis['dataPlan']>['deviceState']> = dataPlan.deviceState ?? {};
    const layeredSafety: Partial<NonNullable<IntentionAnalysis['dataPlan']>['safety']> = dataPlan.safety ?? {};
    const responsePlan: PartialResponsePlan = data.responsePlan ?? {};
    const retrieval: PartialMemoryRetrieval = data.memoryRetrieval ?? {};
    const resolvedContext: PartialResolvedContext = data.resolvedContext ?? {};
    const visual: PartialVisualUnderstanding = data.visualUnderstanding ?? {};
    const routingAction = ROUTING_ACTIONS.includes(routing.action as RoutingAction)
        ? routing.action as RoutingAction
        : inferRoutingAction(data);
    const intent = INTENTS.includes(data.intent as UserIntent)
        ? data.intent as UserIntent
        : inferIntentFromRouting(routingAction);
    const dialogueAct = DIALOGUE_ACTS.includes(data.dialogueAct as DialogueAct)
        ? data.dialogueAct as DialogueAct
        : inferDialogueAct(intent, routingAction);
    const shouldRespond = data.shouldRespond !== undefined
        ? data.shouldRespond !== false
        : routingAction !== 'ignore';
    const shouldEndSession = data.shouldEndSession === true || intent === 'conversation_end' || routingAction === 'end_session';
    const visualRequired = shouldRespond
        && !shouldEndSession
        && (intent === 'visual' || visual.required === true || layeredVision.needed === true);
    const visualReason = stringValue(visual.reason)
        || stringValue(layeredVision.reason)
        || (visualRequired ? '用户请求理解当前摄像头或图像内容' : '当前请求不需要视觉理解');
    const mode = MEMORY_MODES.includes(layeredMemory.mode as MemoryRetrievalMode)
        ? layeredMemory.mode as MemoryRetrievalMode
        : MEMORY_MODES.includes(retrieval.mode as MemoryRetrievalMode)
            ? retrieval.mode as MemoryRetrievalMode
            : 'semantic';
    const timeScope = TIME_SCOPES.includes(retrieval.timeScope as MemoryTimeScope)
        ? retrieval.timeScope as MemoryTimeScope
        : intent === 'memory_recall'
            ? 'recent'
            : 'unspecified';
    const confidence = clampNumber(layeredMemory.confidence, 0, 1, clampNumber(retrieval.confidence, 0, 1, 0.55));
    const memoryExplicitlyNeeded = layeredMemory.needed === true || retrieval.enabled === true;
    const memoryExplicitlyDisabled = layeredMemory.needed === false || retrieval.enabled === false;
    const memoryAllowed = shouldRespond && !shouldEndSession && !['ignore', 'end_session', 'ask_clarification', 'refuse'].includes(routingAction);
    const enabled = memoryAllowed
        && mode !== 'none'
        && !memoryExplicitlyDisabled
        && (memoryExplicitlyNeeded || confidence >= 0.55);
    const query = stringValue(layeredMemory.query)
        || stringValue(contextResolution.memoryQueryRewrite)
        || stringValue(retrieval.query)
        || fallbackQuery;
    const topics = normalizeTopics(layeredMemory.topics, retrieval.topics);
    const reason = stringValue(layeredMemory.reason) || stringValue(retrieval.reason);
    const isFollowUp = Boolean(contextResolution.isFollowUp ?? resolvedContext.isFollowUp);
    const topic = stringValue(contextResolution.topic) || stringValue(resolvedContext.topic);
    const rewrite = stringValue(contextResolution.responseRewrite)
        || stringValue(resolvedContext.rewrite)
        || (shouldRespond ? fallbackQuery : '');
    const currentSessionSufficient = contextResolution.currentSessionSufficient === true || (!enabled && isFollowUp);
    const responseStyle = RESPONSE_PLAN_STYLES.includes(responsePlan.style as ResponsePlanStyle)
        ? responsePlan.style as ResponsePlanStyle
        : inferResponsePlanStyle(routingAction);
    const memoryMode = intent === 'memory_recall'
        ? 'recent_recall'
        : enabled ? mode : 'none';
    const memoryEnabled = intent === 'memory_recall' ? true : enabled;

    return createAnalysis({
        intent,
        dialogueAct,
        shouldRespond,
        shouldEndSession,
        visualRequired,
        visualReason,
        memoryEnabled,
        memoryMode,
        memoryQuery: memoryEnabled ? query : '',
        topics,
        timeScope: intent === 'memory_recall' && timeScope === 'unspecified' ? 'recent' : timeScope,
        memoryConfidence: intent === 'memory_recall' ? Math.max(confidence, 0.55) : confidence,
        memoryReason: reason || (intent === 'memory_recall' ? '用户请求回顾长期记忆或最近对话主题' : ''),
        isFollowUp,
        topic,
        rewrite,
        routingAction,
        routingReason: stringValue(routing.reason) || inferRoutingReason(routingAction),
        routingConfidence: clampNumber(routing.confidence, 0, 1, confidence),
        currentSessionSufficient,
        memoryCanFetchInParallel: layeredMemory.canFetchInParallel !== false,
        visionCanFetchInParallel: layeredVision.canFetchInParallel !== false,
        deviceStateNeeded: layeredDeviceState.needed === true,
        deviceTargets: normalizeStringArray(layeredDeviceState.targets),
        deviceStateReason: stringValue(layeredDeviceState.reason),
        safetyRiskLevel: SAFETY_RISK_LEVELS.includes(layeredSafety.riskLevel as SafetyRiskLevel) ? layeredSafety.riskLevel as SafetyRiskLevel : 'none',
        safetyRequiresIdentity: layeredSafety.requiresIdentity === true,
        safetyRequiresConfirmation: layeredSafety.requiresConfirmation === true,
        safetyReason: stringValue(layeredSafety.reason),
        responseStyle,
        clarificationQuestion: stringValue(responsePlan.clarificationQuestion),
        routingDiagnostics: normalizeRoutingDiagnostics(data.routingDiagnostics),
    });
}

function createFallbackAnalysis(query: string, reason: string): IntentionAnalysis {
    console.log(`[Intention] fallback=${reason}`);
    return createAnalysis({
        traceId: '',
        intent: 'qa',
        dialogueAct: 'new_request',
        shouldRespond: true,
        shouldEndSession: false,
        visualRequired: false,
        visualReason: 'fallback cannot safely infer visual need',
        memoryEnabled: true,
        memoryMode: 'semantic',
        memoryQuery: query,
        topics: [],
        timeScope: 'unspecified',
        memoryConfidence: 0.55,
        memoryReason: reason,
        isFollowUp: false,
        topic: '',
        rewrite: query,
        routingAction: 'answer_after_context',
        routingReason: 'fallback semantic retrieval',
        currentSessionSufficient: false,
        responseStyle: 'brief_answer',
        routingDiagnostics: {
            source: 'fallback',
            modelSkipped: false,
        },
    });
}

function toCompatAnalysis(decision: CoreRoutingDecision, options: {
    routingReason: string;
    memoryReason: string;
    visualReason: string;
    confidence: number;
    safetyRiskLevel?: SafetyRiskLevel;
    safetyReason?: string;
    clarificationQuestion?: string;
    routingDiagnostics?: IntentionAnalysis['routingDiagnostics'];
}): IntentionAnalysis {
    const shouldRespond = !['ignore'].includes(decision.routingAction);
    const shouldEndSession = decision.routingAction === 'end_session' || decision.intent === 'conversation_end';
    const memoryAllowed = shouldRespond
        && !shouldEndSession
        && !['ignore', 'end_session', 'ask_clarification', 'refuse', 'execute_device'].includes(decision.routingAction);
    const memoryEnabled = memoryAllowed && decision.requiresLongTermMemory;
    const memoryMode: MemoryRetrievalMode = memoryEnabled
        ? decision.intent === 'memory_recall' ? 'recent_recall' : 'semantic'
        : 'none';
    const rewrite = decision.resolvedContext.rewriteQuery;
    const requiresVision = decision.intent === 'visual';
    const requiresDeviceState = decision.requiresToolsOrMCP && decision.intent === 'device_control';
    const responseStyle = inferResponsePlanStyle(decision.routingAction);
    const confidence = clampNumber(options.confidence, 0, 1, 0.86);

    return createAnalysis({
        traceId: decision.traceId,
        intent: decision.intent,
        dialogueAct: decision.dialogueAct,
        shouldRespond,
        shouldEndSession,
        visualRequired: requiresVision,
        visualReason: requiresVision
            ? options.visualReason
            : 'core routing did not require current visual understanding',
        memoryEnabled,
        memoryMode,
        memoryQuery: memoryEnabled ? rewrite : '',
        topics: normalizeTopicsFromDecision(decision),
        timeScope: decision.intent === 'memory_recall' ? 'recent' : 'unspecified',
        memoryConfidence: memoryEnabled
            ? decision.intent === 'memory_recall' ? 0.55 : Math.max(confidence, 0.55)
            : confidence,
        memoryReason: memoryEnabled ? options.memoryReason : 'core routing disabled long-term memory',
        isFollowUp: decision.resolvedContext.isFollowUp,
        topic: decision.resolvedContext.topic,
        rewrite,
        routingAction: decision.routingAction,
        routingReason: options.routingReason,
        routingConfidence: confidence,
        currentSessionSufficient: !memoryEnabled,
        memoryCanFetchInParallel: true,
        visionCanFetchInParallel: true,
        deviceStateNeeded: requiresDeviceState,
        deviceTargets: requiresDeviceState ? inferDeviceTargets(rewrite) : [],
        deviceStateReason: requiresDeviceState ? 'core routing requested device control/tool execution' : '',
        safetyRiskLevel: options.safetyRiskLevel,
        safetyRequiresConfirmation: options.safetyRiskLevel ? options.safetyRiskLevel !== 'none' : false,
        safetyReason: options.safetyReason,
        responseStyle,
        clarificationQuestion: options.clarificationQuestion,
        routingDiagnostics: options.routingDiagnostics,
    });
}

function withTraceAndCoreFields(analysis: IntentionAnalysis, traceId: string): IntentionAnalysis {
    const routingAction = analysis.routingAction ?? analysis.routing?.action ?? inferRoutingAction(analysis);
    const requiresLongTermMemory = analysis.requiresLongTermMemory
        ?? analysis.dataPlan?.memory.needed
        ?? (analysis.memoryRetrieval.enabled && analysis.memoryRetrieval.mode !== 'none');
    const requiresToolsOrMCP = analysis.requiresToolsOrMCP
        ?? analysis.dataPlan?.deviceState.needed
        ?? analysis.dataPlan?.vision.needed
        ?? analysis.visualUnderstanding.required
        ?? false;
    const rewriteQuery = analysis.resolvedContext.rewriteQuery
        || analysis.contextResolution?.memoryQueryRewrite
        || analysis.memoryRetrieval.query
        || analysis.contextResolution?.responseRewrite
        || analysis.resolvedContext.rewrite;

    return {
        ...analysis,
        traceId,
        routingAction,
        requiresLongTermMemory,
        requiresToolsOrMCP,
        resolvedContext: {
            ...analysis.resolvedContext,
            rewriteQuery,
        },
    };
}

function createAnalysis(input: {
    traceId?: string;
    intent: UserIntent;
    dialogueAct: DialogueAct;
    shouldRespond: boolean;
    shouldEndSession: boolean;
    visualRequired: boolean;
    visualReason: string;
    memoryEnabled: boolean;
    memoryMode: MemoryRetrievalMode;
    memoryQuery: string;
    topics: string[];
    timeScope: MemoryTimeScope;
    memoryConfidence: number;
    memoryReason: string;
    isFollowUp: boolean;
    topic: string;
    rewrite: string;
    routingAction: RoutingAction;
    routingReason: string;
    routingConfidence?: number;
    currentSessionSufficient: boolean;
    memoryCanFetchInParallel?: boolean;
    visionCanFetchInParallel?: boolean;
    deviceStateNeeded?: boolean;
    deviceTargets?: string[];
    deviceStateReason?: string;
    safetyRiskLevel?: SafetyRiskLevel;
    safetyRequiresIdentity?: boolean;
    safetyRequiresConfirmation?: boolean;
    safetyReason?: string;
    responseStyle: ResponsePlanStyle;
    clarificationQuestion?: string;
    routingDiagnostics?: IntentionAnalysis['routingDiagnostics'];
}): IntentionAnalysis {
    return {
        traceId: input.traceId ?? '',
        routingDiagnostics: input.routingDiagnostics,
        intent: input.intent,
        dialogueAct: input.dialogueAct,
        routingAction: input.routingAction,
        resolvedContext: {
            isFollowUp: input.isFollowUp,
            topic: input.topic,
            rewriteQuery: input.rewrite,
            rewrite: input.rewrite,
        },
        requiresLongTermMemory: input.memoryEnabled && input.memoryMode !== 'none',
        requiresToolsOrMCP: input.visualRequired || (input.deviceStateNeeded ?? false),
        routing: {
            action: input.routingAction,
            confidence: clampNumber(input.routingConfidence, 0, 1, input.memoryConfidence),
            reason: input.routingReason,
        },
        contextResolution: {
            isFollowUp: input.isFollowUp,
            topic: input.topic,
            responseRewrite: input.rewrite,
            memoryQueryRewrite: input.memoryQuery,
            currentSessionSufficient: input.currentSessionSufficient,
        },
        dataPlan: {
            memory: {
                needed: input.memoryEnabled,
                mode: input.memoryMode,
                query: input.memoryQuery,
                topics: input.topics,
                canFetchInParallel: input.memoryCanFetchInParallel ?? true,
                reason: input.memoryReason,
                confidence: input.memoryConfidence,
            },
            vision: {
                needed: input.visualRequired,
                canFetchInParallel: input.visionCanFetchInParallel ?? true,
                reason: input.visualReason,
            },
            deviceState: {
                needed: input.deviceStateNeeded ?? false,
                targets: input.deviceTargets ?? [],
                reason: input.deviceStateReason ?? '',
            },
            safety: {
                riskLevel: input.safetyRiskLevel ?? 'none',
                requiresIdentity: input.safetyRequiresIdentity ?? false,
                requiresConfirmation: input.safetyRequiresConfirmation ?? false,
                reason: input.safetyReason ?? '',
            },
        },
        responsePlan: {
            style: input.responseStyle,
            clarificationQuestion: input.clarificationQuestion ?? '',
        },
        shouldRespond: input.shouldRespond,
        shouldEndSession: input.shouldEndSession,
        visualUnderstanding: {
            required: input.visualRequired,
            reason: input.visualReason,
        },
        memoryRetrieval: {
            enabled: input.memoryEnabled,
            mode: input.memoryMode,
            query: input.memoryQuery,
            topics: input.topics,
            timeScope: input.timeScope,
            confidence: input.memoryConfidence,
            reason: input.memoryReason,
        },
    };
}

function inferRoutingAction(data: Partial<IntentionAnalysis>): RoutingAction {
    if (data.shouldEndSession === true || data.intent === 'conversation_end') return 'end_session';
    if (data.shouldRespond === false || data.intent === 'non_actionable' || data.intent === 'acknowledgement') return 'ignore';
    if (data.visualUnderstanding?.required === true || data.memoryRetrieval?.enabled === true) return 'answer_after_context';
    if (data.intent === 'device_control') return 'execute_device';
    return 'direct_answer';
}

function inferIntentFromRouting(action: RoutingAction): UserIntent {
    switch (action) {
        case 'ignore':
            return 'non_actionable';
        case 'end_session':
            return 'conversation_end';
        case 'execute_device':
            return 'device_control';
        default:
            return 'qa';
    }
}

function inferDialogueAct(intent: UserIntent, action: RoutingAction): DialogueAct {
    if (action === 'end_session' || intent === 'conversation_end') return 'closing';
    if (intent === 'follow_up') return 'follow_up';
    if (intent === 'acknowledgement') return 'answer_to_assistant';
    if (intent === 'non_actionable') return 'noise';
    return 'new_request';
}

function inferResponsePlanStyle(action: RoutingAction): ResponsePlanStyle {
    switch (action) {
        case 'ask_clarification':
            return 'clarification_question';
        case 'refuse':
            return 'refusal';
        case 'execute_device':
        case 'end_session':
            return 'brief_confirm';
        default:
            return 'brief_answer';
    }
}

function inferRoutingReason(action: RoutingAction): string {
    switch (action) {
        case 'ignore':
            return '输入不需要回复';
        case 'end_session':
            return '用户结束当前会话';
        case 'execute_device':
            return '用户请求设备控制';
        case 'answer_after_context':
            return '需要补充上下文后回答';
        case 'ask_clarification':
            return '缺少必要信息，需要澄清';
        case 'refuse':
            return '请求不能执行或需要拒绝';
        case 'direct_answer':
        default:
            return '可以直接回答';
    }
}

function normalizeTopics(primary: unknown, fallback: unknown): string[] {
    const source = Array.isArray(primary) ? primary : Array.isArray(fallback) ? fallback : [];
    return source
        .filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0)
        .map(topic => topic.trim())
        .slice(0, 5);
}

function normalizeStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
        : [];
}

function normalizeRoutingDiagnostics(value: unknown): IntentionAnalysis['routingDiagnostics'] | undefined {
    if (!isRecord(value)) return undefined;
    const source = value.source;
    if (source !== 'pre-router' && source !== 'qwen-router' && source !== 'fallback') return undefined;
    return {
        source,
        preRouterLayer: PreRouterLayerValues.includes(value.preRouterLayer as PreRouterLayer)
            ? value.preRouterLayer as PreRouterLayer
            : undefined,
        preRouterRule: stringValue(value.preRouterRule) || undefined,
        normalizedCommand: stringValue(value.normalizedCommand) || undefined,
        modelSkipped: value.modelSkipped === true,
    };
}

function normalizeTopicsFromDecision(decision: CoreRoutingDecision): string[] {
    if (decision.resolvedContext.topic.trim()) return [decision.resolvedContext.topic.trim()];
    switch (decision.intent) {
        case 'memory_recall':
            return ['最近记忆回顾'];
        case 'device_control':
            return ['智能家居控制'];
        case 'visual':
            return ['视觉理解'];
        default:
            return [];
    }
}

function inferDeviceTargets(rewrite: string): string[] {
    const targets: string[] = [];
    if (/灯|light/i.test(rewrite)) targets.push('light');
    if (/空调|air\s*conditioner|ac/i.test(rewrite)) targets.push('air_conditioner');
    if (/窗帘|curtain/i.test(rewrite)) targets.push('curtain');
    return targets;
}

function isMemoryRecallCommand(command: string): boolean {
    return /(最近|之前|以前|上次|过去|刚才).*(聊|说|谈|记得|记忆|话题)|聊过什么|说过什么|记得什么|刚才说了什么|我刚才说了什么/u.test(command);
}

function logIntentionTrace(state: Record<string, unknown>, severity: 'info' | 'warn' | 'error' = 'info'): void {
    recordModelDecision('Intention', String(state.stage ?? 'trace'), state);
    if (severity === 'info') return;
    pipelineLogs.recordIncident({
        pipelineId: typeof state.pipelineId === 'string' ? state.pipelineId : undefined,
        conversationId: typeof state.conversationId === 'string' ? state.conversationId : undefined,
        stage: 'intent',
        reason: String(state.stage ?? 'trace'),
        severity,
        inputSnapshot: state.messages,
        metadata: state,
    });
}

function createTraceId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function inferRecentTopic(messages: ConversationMessage[]): string {
    const lastUserMessage = [...messages].reverse().find(message => message.role === 'user' && message.content.trim());
    return lastUserMessage?.content.trim() ?? '';
}

function inferRecentAssistantTopic(messages: ConversationMessage[]): string {
    const lastAssistantMessage = [...messages].reverse().find(message => message.role === 'agent' && message.content.trim());
    return lastAssistantMessage?.content.trim().slice(0, 80) ?? '';
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

function traceIntention(
    command: string,
    analysis: IntentionAnalysis,
    source: 'model' | 'fallback' | 'pre-router',
    metadata: Record<string, unknown> = {},
): void {
    const details = Object.entries(metadata)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
    console.log(
        `[Intention] traceId=${analysis.traceId ?? ''} source=${source} command="${command}" intent=${analysis.intent} dialogueAct=${analysis.dialogueAct} routingAction=${analysis.routingAction ?? analysis.routing?.action ?? ''} shouldRespond=${analysis.shouldRespond} shouldEndSession=${analysis.shouldEndSession} visionRequired=${analysis.visualUnderstanding.required} visionReason="${analysis.visualUnderstanding.reason}" memoryEnabled=${analysis.memoryRetrieval.enabled} mode=${analysis.memoryRetrieval.mode} query="${analysis.memoryRetrieval.query}" confidence=${analysis.memoryRetrieval.confidence} reason="${analysis.memoryRetrieval.reason}"${details ? ` ${details}` : ''}`,
    );
}
