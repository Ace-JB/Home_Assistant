import { describe, expect, test } from 'bun:test';
import { BenchmarkService, getBenchmarkMetadata, stats } from '@server/services/BenchmarkService';
import { PipelineLogService } from '@server/services/PipelineLogService';

describe('BenchmarkService', () => {
    test('normalizes benchmark metadata from pipeline metadata', () => {
        const metadata = getBenchmarkMetadata({
            benchmark: {
                runId: 'bench-1',
                scenarioId: 'plain_chat_short',
                variantId: 'ollama-qwen',
                iteration: 2,
                warmup: true,
                backend: 'ollama',
                textModel: 'qwen2.5:7b',
                ctxSize: 4096,
            },
        });

        expect(metadata).toEqual({
            runId: 'bench-1',
            scenarioId: 'plain_chat_short',
            variantId: 'ollama-qwen',
            iteration: 2,
            warmup: true,
            backend: 'ollama',
            textModel: 'qwen2.5:7b',
            visionModel: undefined,
            ctxSize: 4096,
            notes: undefined,
        });
        expect(getBenchmarkMetadata({})).toBeNull();
    });

    test('calculates avg and percentile metrics', () => {
        expect(stats([100, 300, 200, 900])).toEqual({
            count: 4,
            avgMs: 375,
            p50Ms: 200,
            p90Ms: 900,
            minMs: 100,
            maxMs: 900,
        });
        expect(stats([])).toEqual({ count: 0 });
    });

    test('aggregates benchmark pipelines while excluding warmup latency', () => {
        const logs = new PipelineLogService();
        const service = new BenchmarkService(logs);

        seedBenchmarkPipeline(logs, {
            id: 'warmup',
            runId: 'bench-1',
            scenarioId: 'plain_chat_short',
            variantId: 'ollama-qwen',
            iteration: 0,
            warmup: true,
            status: 'completed',
            durationMs: 9999,
        });
        seedBenchmarkPipeline(logs, {
            id: 'sample-1',
            runId: 'bench-1',
            scenarioId: 'plain_chat_short',
            variantId: 'ollama-qwen',
            iteration: 1,
            status: 'completed',
            durationMs: 1000,
            modelDurationMs: 500,
            outputChars: 100,
            coldStart: true,
        });
        seedBenchmarkPipeline(logs, {
            id: 'sample-2',
            runId: 'bench-1',
            scenarioId: 'plain_chat_short',
            variantId: 'ollama-qwen',
            iteration: 2,
            status: 'completed',
            durationMs: 3000,
            modelDurationMs: 1500,
            outputChars: 300,
        });
        seedBenchmarkPipeline(logs, {
            id: 'sample-failed',
            runId: 'bench-1',
            scenarioId: 'plain_chat_short',
            variantId: 'ollama-qwen',
            iteration: 3,
            status: 'failed',
            durationMs: 5000,
        });

        const run = service.getRun('bench-1');
        const summary = run.scenarioSummaries[0]!;

        expect(run.variants).toEqual(['ollama-qwen']);
        expect(summary.total).toBe(3);
        expect(summary.completed).toBe(2);
        expect(summary.failed).toBe(1);
        expect(summary.successRate).toBe(2 / 3);
        expect(summary.pipelineDuration.avgMs).toBe(2000);
        expect(summary.pipelineDuration.p50Ms).toBe(1000);
        expect(summary.pipelineDuration.p90Ms).toBe(3000);
        expect(summary.outputChars).toBe(400);
        expect(summary.charsPerSecond).toBe(200);
        expect(summary.coldStarts).toBe(1);
    });

    test('lists benchmark runs separately from ordinary pipelines', () => {
        const logs = new PipelineLogService();
        const service = new BenchmarkService(logs);
        logs.startPipeline({ id: 'ordinary', kind: 'conversation', title: 'Ordinary' });
        seedBenchmarkPipeline(logs, {
            id: 'bench-pipe',
            runId: 'bench-list',
            scenarioId: 'direct_qa',
            variantId: 'variant-a',
            iteration: 0,
            status: 'completed',
            durationMs: 100,
        });

        expect(service.listRuns().map(run => run.runId)).toEqual(['bench-list']);
    });
});

function seedBenchmarkPipeline(
    logs: PipelineLogService,
    input: {
        id: string;
        runId: string;
        scenarioId: string;
        variantId: string;
        iteration: number;
        warmup?: boolean;
        status: 'completed' | 'failed';
        durationMs: number;
        modelDurationMs?: number;
        outputChars?: number;
        coldStart?: boolean;
    },
): void {
    const benchmark = {
        runId: input.runId,
        scenarioId: input.scenarioId,
        variantId: input.variantId,
        iteration: input.iteration,
        warmup: input.warmup,
        backend: 'ollama',
        textModel: 'qwen',
        ctxSize: 4096,
    };
    logs.startPipeline({
        id: input.id,
        kind: 'conversation',
        title: 'Benchmark',
        startedAt: 1000,
        metadata: { benchmark },
    });
    logs.appendEvent({
        pipelineId: input.id,
        stage: 'intent',
        eventType: 'stage_complete',
        title: 'Intent',
        timings: [{ key: 'intent', label: 'Intent', durationMs: 100 }],
        metadata: { benchmark },
    });
    if (input.modelDurationMs !== undefined) {
        logs.recordModelCall({
            id: `model-${input.id}`,
            pipelineId: input.id,
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            durationMs: input.modelDurationMs,
            inputChars: 100,
            outputChars: input.outputChars ?? 0,
            metadata: { benchmark, coldStart: input.coldStart ?? false },
        });
    }
    if (input.status === 'failed') {
        logs.recordIncident({
            pipelineId: input.id,
            stage: 'model',
            severity: 'error',
            reason: 'failed',
            metadata: { benchmark },
        });
    }
    logs.completePipeline(input.id, {
        status: input.status,
        completedAt: 1000 + input.durationMs,
        metadata: { benchmark },
    });
}
