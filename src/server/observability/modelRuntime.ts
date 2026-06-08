import { pipelineLogs, type ModelCallRecord, type PipelineStage } from '@/server/services/PipelineLogService';

type ModelCallContext = {
    scope: string;
    modelId: string;
    traceId?: string | null;
    conversationId?: string | null;
    pipelineId?: string | null;
    stage?: PipelineStage;
    userCommand?: string;
    benchmark?: unknown;
};

type GenerateLike = (options: any) => Promise<{ text: string }>;
type StreamLike = (options: any) => Promise<{ textStream: AsyncIterable<string> }>;

const seenModels = new Set<string>();

export async function generateTextWithRuntimeLog<T extends { text: string }>(
    generate: (options: any) => Promise<T>,
    options: any,
    context: ModelCallContext,
): Promise<T> {
    const startedAt = Date.now();
    const coldStart = markColdStart(context.modelId);
    const requestLog = appendModelCall('started', startedAt, context, {
        status: 'started',
        coldStart,
        inputChars: estimateInputChars(options),
        promptPreview: extractPromptPreview(options),
    });
    try {
        const result = await generate(options);
        const durationMs = Date.now() - startedAt;
        appendModelCall('complete', Date.now(), context, {
            status: 'complete',
            coldStart,
            inputChars: estimateInputChars(options),
            outputChars: result.text?.length ?? 0,
            outputPreview: result.text ?? '',
            durationMs,
        }, requestLog.id);
        if (coldStart && context.pipelineId) {
            pipelineLogs.appendEvent({
                pipelineId: context.pipelineId,
                conversationId: context.conversationId,
                ts: Date.now(),
                stage: context.stage ?? 'model',
                eventType: 'summary',
                level: 'info',
                title: 'Model cold start',
                message: `${context.modelId} 首次调用`,
                timings: [{ key: 'model_cold_start', label: `${context.modelId} 首次调用`, durationMs }],
                metadata: { modelId: context.modelId, scope: context.scope, modelCallId: requestLog.id },
            });
        }
        return result;
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        appendModelCall('failed', Date.now(), context, {
            status: 'failed',
            coldStart,
            inputChars: estimateInputChars(options),
            error: getErrorMessage(error),
            durationMs,
        }, requestLog.id);
        throw error;
    }
}

export async function streamTextWithRuntimeLog(
    stream: StreamLike,
    options: any,
    context: ModelCallContext,
): Promise<{ textStream: AsyncIterable<string> }> {
    const startedAt = Date.now();
    const coldStart = markColdStart(context.modelId);
    const requestLog = appendModelCall('started', startedAt, context, {
        status: 'started',
        coldStart,
        inputChars: estimateInputChars(options),
        promptPreview: extractPromptPreview(options),
    });
    try {
        const result = await stream(options);
        return {
            ...result,
            textStream: observeTextStream(result.textStream, {
                startedAt,
                requestLogId: requestLog.id,
                coldStart,
                context,
            }),
        };
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        appendModelCall('failed', Date.now(), context, {
            status: 'failed',
            coldStart,
            inputChars: estimateInputChars(options),
            error: getErrorMessage(error),
            durationMs,
        }, requestLog.id);
        throw error;
    }
}

async function* observeTextStream(
    textStream: AsyncIterable<string>,
    input: {
        startedAt: number;
        requestLogId: string;
        coldStart: boolean;
        context: ModelCallContext;
    },
): AsyncIterable<string> {
    let output = '';
    try {
        for await (const delta of textStream) {
            output += delta;
            yield delta;
        }
        const durationMs = Date.now() - input.startedAt;
        appendModelCall('complete', Date.now(), input.context, {
            status: 'complete',
            coldStart: input.coldStart,
            outputChars: output.length,
            outputPreview: output,
            durationMs,
        }, input.requestLogId);
        if (input.coldStart && input.context.pipelineId) {
            pipelineLogs.appendEvent({
                pipelineId: input.context.pipelineId,
                conversationId: input.context.conversationId,
                ts: Date.now(),
                stage: input.context.stage ?? 'model',
                eventType: 'summary',
                level: 'info',
                title: 'Model cold start',
                message: `${input.context.modelId} 首次调用`,
                timings: [{ key: 'model_cold_start', label: `${input.context.modelId} 首次调用`, durationMs }],
                metadata: { modelId: input.context.modelId, scope: input.context.scope, modelCallId: input.requestLogId },
            });
        }
    } catch (error) {
        const durationMs = Date.now() - input.startedAt;
        appendModelCall('failed', Date.now(), input.context, {
            status: 'failed',
            coldStart: input.coldStart,
            outputChars: output.length,
            error: getErrorMessage(error),
            durationMs,
        }, input.requestLogId);
        throw error;
    }
}

function appendModelCall(
    status: ModelCallRecord['status'],
    ts: number,
    context: ModelCallContext,
    metadata: Record<string, unknown>,
    relatedModelCallId?: string,
): ModelCallRecord {
    return pipelineLogs.recordModelCall({
        id: relatedModelCallId,
        ts,
        pipelineId: resolvePipelineId(context),
        conversationId: context.conversationId ?? undefined,
        stage: context.stage ?? 'model',
        scope: context.scope,
        modelId: context.modelId,
        status,
        durationMs: numberValue(metadata.durationMs),
        inputChars: numberValue(metadata.inputChars),
        outputChars: numberValue(metadata.outputChars),
        promptPreview: stringValue(metadata.promptPreview),
        outputPreview: stringValue(metadata.outputPreview),
        error: stringValue(metadata.error),
        metadata: {
            traceId: context.traceId ?? null,
            userCommand: context.userCommand ?? null,
            coldStart: metadata.coldStart ?? null,
            benchmark: context.benchmark ?? null,
        },
    });
}

function resolvePipelineId(context: ModelCallContext): string | undefined {
    return context.pipelineId ?? context.conversationId ?? context.traceId ?? undefined;
}

function markColdStart(modelId: string): boolean {
    if (seenModels.has(modelId)) return false;
    seenModels.add(modelId);
    return true;
}

function estimateInputChars(options: any): number {
    return extractPromptPreview(options).length;
}

function extractPromptPreview(options: any): string {
    const chunks: string[] = [];
    if (typeof options?.system === 'string') chunks.push(options.system);
    if (typeof options?.prompt === 'string') chunks.push(options.prompt);
    if (Array.isArray(options?.messages)) chunks.push(JSON.stringify(summarizeMessages(options.messages)));
    return chunks.join('\n');
}

function summarizeMessages(messages: unknown[]): unknown[] {
    return messages.map((message) => {
        if (!message || typeof message !== 'object') return message;
        const record = message as Record<string, unknown>;
        return {
            ...record,
            content: summarizeContent(record.content),
        };
    });
}

function summarizeContent(content: unknown): unknown {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content;
    return content.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const record = item as Record<string, unknown>;
        if (record.type === 'image') {
            return { type: 'image', mimeType: record.mimeType ?? null, imageBytes: estimateBytes(record.image) };
        }
        return record;
    });
}

function estimateBytes(value: unknown): number | null {
    if (typeof value === 'string') return value.length;
    if (value instanceof Uint8Array) return value.byteLength;
    return null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
