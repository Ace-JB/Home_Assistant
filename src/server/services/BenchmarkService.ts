import { GLOBAL_CONFIG } from '@/global_config';
import { brain, type CameraRecognitionContext } from '@modules/brain';
import { memory, type ConversationMessage } from '@modules/memory';
import { pipelineLogs, type ModelCallRecord, type PipelineEvent, type PipelineRun, type PipelineStatus } from '@server/services/PipelineLogService';
import type { AssistantLanguage } from '@tools/Socket';

export type BenchmarkScenarioId =
    | 'plain_chat_short'
    | 'direct_qa'
    | 'follow_up_context'
    | 'memory_recall'
    | 'vision_summary'
    | 'conversation_end';

export type BenchmarkMetadata = {
    runId: string;
    scenarioId: BenchmarkScenarioId | string;
    variantId: string;
    iteration: number;
    warmup?: boolean;
    backend?: string;
    textModel?: string;
    visionModel?: string;
    ctxSize?: number;
    notes?: string;
};

export type BenchmarkScenario = {
    id: BenchmarkScenarioId;
    title: string;
    command: string;
    language: AssistantLanguage;
    recentConversationMessages?: ConversationMessage[];
    image?: Buffer;
    cameraContext?: CameraRecognitionContext;
};

export type BenchmarkRunInput = {
    runId?: string;
    variantId?: string;
    backend?: string;
    textModel?: string;
    visionModel?: string;
    ctxSize?: number;
    notes?: string;
    iterations?: number;
    warmupIterations?: number;
    scenarioIds?: BenchmarkScenarioId[];
};

export type MetricStats = {
    count: number;
    avgMs?: number;
    p50Ms?: number;
    p90Ms?: number;
    minMs?: number;
    maxMs?: number;
};

export type BenchmarkScenarioSummary = {
    runId: string;
    variantId: string;
    scenarioId: string;
    backend?: string;
    textModel?: string;
    visionModel?: string;
    ctxSize?: number;
    total: number;
    completed: number;
    failed: number;
    successRate: number;
    pipelineDuration: MetricStats;
    stageDurations: Record<string, MetricStats>;
    modelDurations: Record<string, MetricStats & { modelId: string; inputChars: number; outputChars: number; charsPerSecond?: number; coldStarts: number }>;
    inputChars: number;
    outputChars: number;
    charsPerSecond?: number;
    coldStarts: number;
    incidentCount: number;
    samplePipelineIds: string[];
    sampleModelCallIds: string[];
};

export type BenchmarkRunSummary = {
    runId: string;
    variants: string[];
    startedAt?: number;
    completedAt?: number;
    scenarioSummaries: BenchmarkScenarioSummary[];
};

export type BenchmarkRunListItem = {
    runId: string;
    variants: string[];
    scenarioCount: number;
    pipelineCount: number;
    startedAt?: number;
    completedAt?: number;
};

export type BenchmarkCompareResult = {
    runs: BenchmarkRunSummary[];
};

type BenchmarkSample = {
    pipeline: PipelineRun;
    metadata: BenchmarkMetadata;
    events: PipelineEvent[];
    modelCalls: ModelCallRecord[];
    incidentCount: number;
};

export const benchmarkScenarios: BenchmarkScenario[] = [
    {
        id: 'plain_chat_short',
        title: 'Plain short chat',
        command: '你好，简单介绍一下你能做什么。',
        language: 'zh',
    },
    {
        id: 'direct_qa',
        title: 'Direct QA',
        command: '用一句话解释什么是本地大模型。',
        language: 'zh',
    },
    {
        id: 'follow_up_context',
        title: 'Follow-up with recent context',
        command: '那第二步呢？',
        language: 'zh',
        recentConversationMessages: [
            { role: 'user', content: '帮我规划一个番茄炒蛋的做饭步骤。', createdAt: '2026-06-07T00:00:00.000Z' },
            { role: 'agent', content: '第一步先准备番茄、鸡蛋和葱花。', createdAt: '2026-06-07T00:00:01.000Z' },
        ],
    },
    {
        id: 'memory_recall',
        title: 'Memory recall',
        command: '我们之前聊过哪些做饭相关的话题？',
        language: 'zh',
    },
    {
        id: 'vision_summary',
        title: 'Vision summary',
        command: '看一下当前画面里有什么需要注意的。',
        language: 'zh',
        image: createTinyJpegPlaceholder(),
        cameraContext: {
            ts: Date.now(),
            faces: [],
            recognizedLabels: [],
            hasStranger: false,
            identityVerification: { verified: false, label: null, reason: 'unavailable' },
            confidence: 'unavailable',
        },
    },
    {
        id: 'conversation_end',
        title: 'Conversation end',
        command: '没事了',
        language: 'zh',
    },
];

export class BenchmarkService {
    constructor(
        private readonly logs = pipelineLogs,
        private readonly memoryStore = memory,
    ) {}

    async run(input: BenchmarkRunInput = {}): Promise<BenchmarkRunSummary> {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('benchmark runner is disabled in production');
        }
        const runId = input.runId?.trim() || `bench-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const variantId = input.variantId?.trim() || defaultVariantId();
        const iterations = positiveInteger(input.iterations, 3);
        const warmupIterations = Math.max(0, positiveInteger(input.warmupIterations, 0));
        const selected = selectScenarios(input.scenarioIds);

        for (const scenario of selected) {
            const totalIterations = warmupIterations + iterations;
            for (let index = 0; index < totalIterations; index++) {
                const metadata: BenchmarkMetadata = {
                    runId,
                    scenarioId: scenario.id,
                    variantId,
                    iteration: index,
                    warmup: index < warmupIterations,
                    backend: input.backend ?? 'ollama',
                    textModel: input.textModel ?? GLOBAL_CONFIG.OLLAMA.TEXT_MODEL,
                    visionModel: input.visionModel ?? GLOBAL_CONFIG.OLLAMA.VISION_MODEL,
                    ctxSize: input.ctxSize ?? GLOBAL_CONFIG.OLLAMA.TEXT_NUM_CTX,
                    notes: input.notes,
                };
                await this.runScenario(scenario, metadata);
            }
        }

        return this.getRun(runId);
    }

    listRuns(): BenchmarkRunListItem[] {
        const byRun = new Map<string, { variants: Set<string>; scenarios: Set<string>; pipelineCount: number; startedAt?: number; completedAt?: number }>();
        for (const pipeline of this.logs.listAllPipelines({ limit: 500 })) {
            const metadata = getBenchmarkMetadata(pipeline.metadata);
            if (!metadata) continue;
            const item = byRun.get(metadata.runId) ?? { variants: new Set(), scenarios: new Set(), pipelineCount: 0 };
            item.variants.add(metadata.variantId);
            item.scenarios.add(metadata.scenarioId);
            item.pipelineCount += 1;
            item.startedAt = item.startedAt === undefined ? pipeline.startedAt : Math.min(item.startedAt, pipeline.startedAt);
            const end = pipeline.completedAt ?? pipeline.startedAt;
            item.completedAt = item.completedAt === undefined ? end : Math.max(item.completedAt, end);
            byRun.set(metadata.runId, item);
        }
        return Array.from(byRun.entries())
            .map(([runId, item]) => ({
                runId,
                variants: Array.from(item.variants).sort(),
                scenarioCount: item.scenarios.size,
                pipelineCount: item.pipelineCount,
                startedAt: item.startedAt,
                completedAt: item.completedAt,
            }))
            .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    }

    getRun(runId: string): BenchmarkRunSummary {
        const samples = this.collectSamples().filter(sample => sample.metadata.runId === runId && !sample.metadata.warmup);
        return summarizeRun(runId, samples);
    }

    compare(runIds: string[]): BenchmarkCompareResult {
        return { runs: runIds.map(runId => this.getRun(runId)) };
    }

    private async runScenario(scenario: BenchmarkScenario, benchmark: BenchmarkMetadata): Promise<void> {
        const pipelineId = `bench-${benchmark.runId}-${benchmark.variantId}-${scenario.id}-${benchmark.iteration}-${Date.now()}`;
        const conversationId = `${pipelineId}-conversation`;
        this.logs.startPipeline({
            id: pipelineId,
            kind: 'conversation',
            title: `Benchmark: ${scenario.title}`,
            conversationId,
            userCommand: scenario.command,
            metadata: { benchmark },
        });
        seedRecentConversation(this.memoryStore, conversationId, scenario.recentConversationMessages);
        const startedAt = Date.now();
        try {
            const result = await brain.processCommandDetailed(
                scenario.command,
                '主人',
                scenario.cameraContext,
                scenario.language,
                scenario.image,
                conversationId,
                { pipelineId, benchmark },
            );
            this.logs.completePipeline(pipelineId, {
                status: 'completed',
                summary: {
                    benchmark,
                    responseChars: result.text.length,
                    shouldRespond: result.shouldRespond,
                    shouldEndSession: result.shouldEndSession,
                },
                metadata: { benchmark, benchmarkDurationMs: Date.now() - startedAt },
            });
        } catch (error) {
            this.logs.recordIncident({
                pipelineId,
                stage: 'summary',
                severity: 'error',
                reason: 'benchmark_run_failed',
                outputSnapshot: error instanceof Error ? error.message : String(error),
                metadata: { benchmark },
            });
            this.logs.completePipeline(pipelineId, {
                status: 'failed',
                metadata: { benchmark, benchmarkDurationMs: Date.now() - startedAt },
            });
        }
    }

    private collectSamples(): BenchmarkSample[] {
        return this.logs.listAllPipelines({ limit: 500 }).flatMap(pipeline => {
            const metadata = getBenchmarkMetadata(pipeline.metadata);
            if (!metadata) return [];
            const detail = this.logs.getPipelineDetail(pipeline.id);
            return [{
                pipeline,
                metadata,
                events: detail?.events ?? [],
                modelCalls: this.logs.listModelCalls({ pipelineId: pipeline.id, limit: 100 }),
                incidentCount: this.logs.listIncidents({ pipelineId: pipeline.id, limit: 100 }).length,
            }];
        });
    }
}

export const benchmarkService = new BenchmarkService();

export function getBenchmarkMetadata(value: unknown): BenchmarkMetadata | null {
    const record = getRecord(value);
    const benchmark = getRecord(record.benchmark);
    const runId = stringValue(benchmark.runId);
    const scenarioId = stringValue(benchmark.scenarioId);
    const variantId = stringValue(benchmark.variantId);
    const iteration = numberValue(benchmark.iteration);
    if (!runId || !scenarioId || !variantId || iteration === undefined) return null;
    return {
        runId,
        scenarioId,
        variantId,
        iteration,
        warmup: booleanValue(benchmark.warmup),
        backend: stringValue(benchmark.backend),
        textModel: stringValue(benchmark.textModel),
        visionModel: stringValue(benchmark.visionModel),
        ctxSize: numberValue(benchmark.ctxSize),
        notes: stringValue(benchmark.notes),
    };
}

export function summarizeRun(runId: string, samples: BenchmarkSample[]): BenchmarkRunSummary {
    const groups = new Map<string, BenchmarkSample[]>();
    for (const sample of samples) {
        const key = `${sample.metadata.variantId}\u0000${sample.metadata.scenarioId}`;
        groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    const scenarioSummaries = Array.from(groups.values())
        .map(summarizeScenario)
        .sort((a, b) => `${a.variantId}:${a.scenarioId}`.localeCompare(`${b.variantId}:${b.scenarioId}`));
    const variants = Array.from(new Set(samples.map(sample => sample.metadata.variantId))).sort();
    const startedAt = minDefined(samples.map(sample => sample.pipeline.startedAt));
    const completedAt = maxDefined(samples.map(sample => sample.pipeline.completedAt ?? sample.pipeline.startedAt));
    return { runId, variants, startedAt, completedAt, scenarioSummaries };
}

function summarizeScenario(samples: BenchmarkSample[]): BenchmarkScenarioSummary {
    const first = samples[0]!;
    const completed = samples.filter(sample => sample.pipeline.status === 'completed');
    const completedDurations = completed.map(sample => sample.pipeline.durationMs).filter(isNumber);
    const modelCalls = samples.flatMap(sample => sample.modelCalls).filter(call => call.status === 'complete');
    const modelDurationMs = sum(modelCalls.map(call => call.durationMs).filter(isNumber));
    const outputChars = sum(modelCalls.map(call => call.outputChars).filter(isNumber));
    const inputChars = sum(modelCalls.map(call => call.inputChars).filter(isNumber));
    return {
        runId: first.metadata.runId,
        variantId: first.metadata.variantId,
        scenarioId: first.metadata.scenarioId,
        backend: first.metadata.backend,
        textModel: first.metadata.textModel,
        visionModel: first.metadata.visionModel,
        ctxSize: first.metadata.ctxSize,
        total: samples.length,
        completed: completed.length,
        failed: samples.filter(sample => sample.pipeline.status === 'failed').length,
        successRate: samples.length > 0 ? completed.length / samples.length : 0,
        pipelineDuration: stats(completedDurations),
        stageDurations: summarizeStageDurations(samples),
        modelDurations: summarizeModelDurations(modelCalls),
        inputChars,
        outputChars,
        charsPerSecond: modelDurationMs > 0 ? outputChars / (modelDurationMs / 1000) : undefined,
        coldStarts: modelCalls.filter(call => getRecord(call.metadata).coldStart === true).length,
        incidentCount: sum(samples.map(sample => sample.incidentCount)),
        samplePipelineIds: samples.map(sample => sample.pipeline.id).slice(0, 10),
        sampleModelCallIds: modelCalls.map(call => call.id).slice(0, 10),
    };
}

function summarizeStageDurations(samples: BenchmarkSample[]): Record<string, MetricStats> {
    const values = new Map<string, number[]>();
    for (const sample of samples) {
        if (sample.pipeline.status !== 'completed') continue;
        for (const event of sample.events) {
            for (const timing of event.timings ?? []) {
                values.set(event.stage, [...(values.get(event.stage) ?? []), timing.durationMs]);
            }
        }
    }
    return Object.fromEntries(Array.from(values.entries()).map(([stage, durations]) => [stage, stats(durations)]));
}

function summarizeModelDurations(modelCalls: ModelCallRecord[]): BenchmarkScenarioSummary['modelDurations'] {
    const groups = new Map<string, ModelCallRecord[]>();
    for (const call of modelCalls) {
        const key = `${call.scope}\u0000${call.modelId}`;
        groups.set(key, [...(groups.get(key) ?? []), call]);
    }
    return Object.fromEntries(Array.from(groups.entries()).map(([key, calls]) => {
        const [, modelId] = key.split('\u0000');
        const durationValues = calls.map(call => call.durationMs).filter(isNumber);
        const outputChars = sum(calls.map(call => call.outputChars).filter(isNumber));
        const inputChars = sum(calls.map(call => call.inputChars).filter(isNumber));
        const durationMs = sum(durationValues);
        return [key.replace('\u0000', ' / '), {
            ...stats(durationValues),
            modelId: modelId ?? '',
            inputChars,
            outputChars,
            charsPerSecond: durationMs > 0 ? outputChars / (durationMs / 1000) : undefined,
            coldStarts: calls.filter(call => getRecord(call.metadata).coldStart === true).length,
        }];
    }));
}

export function stats(values: number[]): MetricStats {
    const sorted = values.filter(isNumber).sort((a, b) => a - b);
    if (sorted.length === 0) return { count: 0 };
    return {
        count: sorted.length,
        avgMs: sum(sorted) / sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
    };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 1) return sorted[0]!;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index]!;
}

function selectScenarios(ids?: BenchmarkScenarioId[]): BenchmarkScenario[] {
    if (!ids?.length) return benchmarkScenarios;
    const allowed = new Set(ids);
    return benchmarkScenarios.filter(scenario => allowed.has(scenario.id));
}

function seedRecentConversation(memoryStore: typeof memory, conversationId: string, messages: ConversationMessage[] = []): void {
    if (!messages.length) {
        memoryStore.createConversationSession({ conversation_id: conversationId });
        return;
    }
    let user = '';
    for (const message of messages) {
        if (message.role === 'user') {
            user = message.content;
        } else if (user) {
            memoryStore.appendConversationTurn({
                conversation_id: conversationId,
                user_content: user,
                agent_content: message.content,
                created_at: message.createdAt,
            });
            user = '';
        }
    }
}

function defaultVariantId(): string {
    return `ollama-${GLOBAL_CONFIG.OLLAMA.TEXT_MODEL.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createTinyJpegPlaceholder(): Buffer {
    return Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', 'base64');
}

function getRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function minDefined(values: Array<number | undefined>): number | undefined {
    const filtered = values.filter(isNumber);
    return filtered.length ? Math.min(...filtered) : undefined;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
    const filtered = values.filter(isNumber);
    return filtered.length ? Math.max(...filtered) : undefined;
}
