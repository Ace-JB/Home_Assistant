import { afterEach, describe, expect, test } from 'bun:test';
import { MlxModelClient } from '@server/services/model-runtime/MlxModelClient';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('MlxModelClient', () => {
    test('streams text deltas from qwen-vlm ndjson', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
            calls.push({ url: input.toString(), init });
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"delta":"你好","done":false}\n'));
                    controller.enqueue(new TextEncoder().encode('{"delta":"，主人","done":false}\n{"done":true}\n'));
                    controller.close();
                },
            });
            return new Response(body, { status: 200 });
        }) as typeof fetch;

        const client = new MlxModelClient('http://vlm.local', 'http://router.local');
        const result = await client.streamText({
            system: 'system prompt',
            messages: [{ role: 'user', content: 'hello' }],
            topP: 0.72,
        });

        let text = '';
        for await (const delta of result.textStream) {
            text += delta;
        }
        const metadata = await result.metadata;

        expect(text).toBe('你好，主人');
        expect(metadata).toBeUndefined();
        expect(calls[0]?.url).toBe('http://vlm.local/chat/stream');
        expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
            system: 'system prompt',
            messages: [{ role: 'user', content: 'hello' }],
            topP: 0.72,
        });
    });

    test('keeps qwen-vlm stream metadata out of user text', async () => {
        globalThis.fetch = (async (_input: URL | RequestInfo, _init?: RequestInit) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"delta":"红烧牛肉做法","done":false}\n'));
                    controller.enqueue(new TextEncoder().encode('{"delta":"","done":true,"modelId":"qwen3-vl","metadata":{"ttftMs":120,"durationMs":920,"generation_tps":33.9,"prompt_tokens":1803,"cached_tokens":0}}\n'));
                    controller.close();
                },
            });
            return new Response(body, { status: 200 });
        }) as typeof fetch;

        const client = new MlxModelClient('http://vlm.local', 'http://router.local');
        const result = await client.generateText({ messages: [{ role: 'user', content: '红烧牛肉怎么做' }] });

        expect(result.text).toBe('红烧牛肉做法');
        expect(result.text).not.toContain('generation_tps');
        expect(result.metadata).toMatchObject({
            modelId: 'qwen3-vl',
            ttftMs: 120,
            durationMs: 920,
            generation_tps: 33.9,
            prompt_tokens: 1803,
            cached_tokens: 0,
        });
    });

    test('sends multipart vision requests without base64 wrapping', async () => {
        let capturedBody: BodyInit | null = null;
        globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
            capturedBody = init?.body ?? null;
            return Response.json({ text: '画面里有一张桌子', modelId: 'qwen3-vl', metadata: { peak_memory: 7.2 } });
        }) as typeof fetch;

        const client = new MlxModelClient('http://vlm.local', 'http://router.local');
        const result = await client.describeVision({
            prompt: '看一下画面',
            image: Buffer.from([1, 2, 3]),
        });

        expect(result.text).toBe('画面里有一张桌子');
        expect(result.metadata).toMatchObject({ modelId: 'qwen3-vl', peak_memory: 7.2 });
        expect(capturedBody).toBeInstanceOf(FormData);
        const form = capturedBody as unknown as FormData;
        expect(String(form.get('payload'))).toContain('"prompt":"看一下画面"');
        expect(form.get('image')).toBeInstanceOf(Blob);
    });

    test('routes fast and repair generation to qwen-router roles', async () => {
        const bodies: unknown[] = [];
        globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({ text: '{"intent":"qa"}', role: JSON.parse(String(init?.body)).role, metadata: { generation_tps: 20 } });
        }) as typeof fetch;

        const client = new MlxModelClient('http://vlm.local', 'http://router.local');
        await client.generateRoutingJson({ role: 'fast', messages: [{ role: 'user', content: 'hi' }] });
        const repair = await client.generateRoutingJson({ role: 'repair', messages: [{ role: 'user', content: 'fix' }] });

        expect(bodies).toMatchObject([
            { role: 'fast', messages: [{ role: 'user', content: 'hi' }] },
            { role: 'repair', messages: [{ role: 'user', content: 'fix' }] },
        ]);
        expect(repair.metadata).toMatchObject({ role: 'repair', generation_tps: 20 });
    });
});
