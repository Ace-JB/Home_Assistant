import { afterEach, describe, expect, test } from 'bun:test';
import { generateTextWithRuntimeLog, streamTextWithRuntimeLog } from '@server/observability/modelRuntime';
import { pipelineLogs } from '@server/services/PipelineLogService';

afterEach(() => {
    pipelineLogs.clear();
});

describe('model runtime logging', () => {
    test('records generate metadata as model metrics', async () => {
        const result = await generateTextWithRuntimeLog(
            async () => ({ text: '红烧牛肉做法', metadata: { generation_tps: 33.9, prompt_tokens: 1803 } }),
            { messages: [{ role: 'user', content: '红烧牛肉怎么做' }] },
            { scope: 'brain.response', modelId: 'qwen3-vl', pipelineId: 'pipe-metrics' },
        );

        const call = pipelineLogs.listModelCalls({ pipelineId: 'pipe-metrics', limit: 1 })[0];
        const metadata = call?.metadata as { modelMetrics?: Record<string, unknown> } | undefined;

        expect(result.text).toBe('红烧牛肉做法');
        expect(metadata?.modelMetrics).toMatchObject({ generation_tps: 33.9, prompt_tokens: 1803 });
    });

    test('records stream metadata after the text stream is consumed', async () => {
        const result = await streamTextWithRuntimeLog(
            async () => ({
                textStream: textDeltas(['红烧', '牛肉']),
                metadata: Promise.resolve({ generation_tps: 21.5, total_tokens: 64 }),
            }),
            { messages: [{ role: 'user', content: '红烧牛肉怎么做' }] },
            { scope: 'brain.stream', modelId: 'qwen3-vl', pipelineId: 'pipe-stream-metrics' },
        );

        let text = '';
        for await (const delta of result.textStream) {
            text += delta;
        }

        const call = pipelineLogs.listModelCalls({ pipelineId: 'pipe-stream-metrics', limit: 1 })[0];
        const metadata = call?.metadata as { modelMetrics?: Record<string, unknown> } | undefined;

        expect(text).toBe('红烧牛肉');
        expect(metadata?.modelMetrics).toMatchObject({ generation_tps: 21.5, total_tokens: 64 });
    });
});

async function* textDeltas(chunks: string[]): AsyncIterable<string> {
    for (const chunk of chunks) {
        yield chunk;
    }
}
