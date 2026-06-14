import { GLOBAL_CONFIG } from '@/global_config';

export type ModelTextMessage = {
    role: string;
    content: string;
};

export type GenerateTextOptions = {
    system?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
};

export type StreamTextResult = {
    textStream: AsyncIterable<string>;
    metadata?: Promise<ModelRuntimeMetadata | undefined>;
};

export type RoutingRole = 'fast' | 'repair';
export type ModelRuntimeMetadata = Record<string, unknown>;

export class MlxModelClient {
    constructor(
        private readonly vlmBaseUrl = GLOBAL_CONFIG.MODEL_SERVICES.QWEN_VLM_BASE_URL,
        private readonly routerBaseUrl = GLOBAL_CONFIG.MODEL_SERVICES.QWEN_ROUTER_BASE_URL,
        private readonly timeoutMs = GLOBAL_CONFIG.MODEL_SERVICES.REQUEST_TIMEOUT_MS,
    ) {}

    async generateText(options: GenerateTextOptions): Promise<{ text: string; metadata?: ModelRuntimeMetadata }> {
        const stream = await this.streamText(options);
        let text = '';
        for await (const delta of stream.textStream) {
            text += delta;
        }
        const metadata = await stream.metadata;
        return metadata ? { text, metadata } : { text };
    }

    async streamText(options: GenerateTextOptions): Promise<StreamTextResult> {
        const response = await this.fetchWithTimeout(new URL('/chat/stream', withTrailingSlash(this.vlmBaseUrl)), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                system: options.system ?? '',
                messages: normalizeMessages(options.messages ?? []),
                maxTokens: options.maxTokens ?? GLOBAL_CONFIG.MODEL_SERVICES.TEXT_MAX_TOKENS,
                temperature: options.temperature ?? GLOBAL_CONFIG.MODEL_SERVICES.TEXT_TEMPERATURE,
                topP: options.topP ?? GLOBAL_CONFIG.MODEL_SERVICES.TEXT_TOP_P,
            }),
        });
        if (!response.ok || !response.body) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Qwen VLM stream failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
        }
        return decodeNdjsonTextStream(response.body);
    }

    async describeVision(input: {
        prompt: string;
        image: Buffer | Uint8Array;
        maxTokens?: number;
        temperature?: number;
    }): Promise<{ text: string; metadata?: ModelRuntimeMetadata }> {
        const form = new FormData();
        form.set('payload', JSON.stringify({
            prompt: input.prompt,
            maxTokens: input.maxTokens ?? GLOBAL_CONFIG.MODEL_SERVICES.VISION_MAX_TOKENS,
            temperature: input.temperature ?? GLOBAL_CONFIG.MODEL_SERVICES.VISION_TEMPERATURE,
        }));
        form.set('image', new Blob([Buffer.from(input.image)], { type: 'image/jpeg' }), 'frame.jpg');
        const response = await this.fetchWithTimeout(new URL('/vision/describe', withTrailingSlash(this.vlmBaseUrl)), {
            method: 'POST',
            body: form,
        });
        const body = await response.text();
        if (!response.ok) {
            throw new Error(`Qwen VLM vision failed status=${response.status}${body ? ` detail=${body.slice(0, 300)}` : ''}`);
        }
        const parsed = JSON.parse(body) as { text?: string; metadata?: unknown; durationMs?: number; modelId?: string };
        const metadata = responseMetadata(parsed);
        return metadata ? { text: parsed.text ?? '', metadata } : { text: parsed.text ?? '' };
    }

    async generateRoutingJson(input: {
        role: RoutingRole;
        messages: Array<{ role?: string; content?: unknown }>;
        maxTokens?: number;
        temperature?: number;
    }): Promise<{ text: string; metadata?: ModelRuntimeMetadata }> {
        const response = await this.fetchWithTimeout(new URL('/generate', withTrailingSlash(this.routerBaseUrl)), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                role: input.role,
                messages: normalizeMessages(input.messages),
                maxTokens: input.maxTokens ?? GLOBAL_CONFIG.MODEL_SERVICES.ROUTER_MAX_TOKENS,
                temperature: input.temperature ?? 0,
            }),
        });
        const body = await response.text();
        if (!response.ok) {
            throw new Error(`Qwen router generate failed role=${input.role} status=${response.status}${body ? ` detail=${body.slice(0, 300)}` : ''}`);
        }
        const parsed = JSON.parse(body) as { text?: string; metadata?: unknown; durationMs?: number; modelId?: string; role?: string };
        const metadata = responseMetadata(parsed);
        return metadata ? { text: parsed.text ?? '', metadata } : { text: parsed.text ?? '' };
    }

    async health(): Promise<{ vlmReady: boolean; routerReady: boolean }> {
        const [vlm, router] = await Promise.all([
            fetch(new URL('/health', withTrailingSlash(this.vlmBaseUrl))).then(r => r.json()).catch(() => null),
            fetch(new URL('/health', withTrailingSlash(this.routerBaseUrl))).then(r => r.json()).catch(() => null),
        ]);
        return {
            vlmReady: Boolean(vlm?.ready ?? vlm?.ok),
            routerReady: Boolean(router?.ready ?? router?.ok),
        };
    }

    private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
        const signal = AbortSignal.timeout(this.timeoutMs);
        return fetch(url, { ...init, signal });
    }
}

export const mlxModelClient = new MlxModelClient();

function normalizeMessages(messages: Array<{ role?: string; content?: unknown }>): ModelTextMessage[] {
    return messages.map(message => ({
        role: message.role ?? 'user',
        content: stringifyMessageContent(message.content),
    }));
}

function stringifyMessageContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part) {
                    return String((part as { text?: unknown }).text ?? '');
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content === undefined || content === null) return '';
    return String(content);
}

function decodeNdjsonTextStream(body: ReadableStream<Uint8Array>): StreamTextResult {
    let resolveMetadata: (metadata: ModelRuntimeMetadata | undefined) => void = () => {};
    const metadataPromise = new Promise<ModelRuntimeMetadata | undefined>((resolve) => {
        resolveMetadata = resolve;
    });
    let metadata: ModelRuntimeMetadata | undefined;

    async function* textStream(): AsyncIterable<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex >= 0) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    const delta = parseStreamLine(line);
                    if (delta.error) throw new Error(delta.error);
                    metadata = mergeMetadata(metadata, delta.metadata);
                    if (delta.text) yield delta.text;
                    newlineIndex = buffer.indexOf('\n');
                }
            }
            const trailing = buffer.trim();
            if (trailing) {
                const delta = parseStreamLine(trailing);
                if (delta.error) throw new Error(delta.error);
                metadata = mergeMetadata(metadata, delta.metadata);
                if (delta.text) yield delta.text;
            }
        } finally {
            resolveMetadata(metadata);
        }
    }

    return { textStream: textStream(), metadata: metadataPromise };
}

function parseStreamLine(line: string): { text: string; error?: string; metadata?: ModelRuntimeMetadata } {
    if (!line) return { text: '' };
    const normalized = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!normalized || normalized === '[DONE]') return { text: '' };
    const parsed = JSON.parse(normalized) as { delta?: string; text?: string; error?: string; done?: boolean; metadata?: unknown; durationMs?: number; modelId?: string };
    return { text: parsed.delta ?? parsed.text ?? '', error: parsed.error, metadata: responseMetadata(parsed) };
}

function responseMetadata(response: { metadata?: unknown; durationMs?: number; modelId?: string; role?: string }): ModelRuntimeMetadata | undefined {
    return mergeMetadata(asRecord(response.metadata), {
        ...(typeof response.durationMs === 'number' ? { durationMs: response.durationMs } : {}),
        ...(typeof response.modelId === 'string' ? { modelId: response.modelId } : {}),
        ...(typeof response.role === 'string' ? { role: response.role } : {}),
    });
}

function mergeMetadata(
    left: ModelRuntimeMetadata | undefined,
    right: ModelRuntimeMetadata | undefined,
): ModelRuntimeMetadata | undefined {
    if (!left && !right) return undefined;
    const merged = { ...(left ?? {}), ...(right ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
}

function asRecord(value: unknown): ModelRuntimeMetadata | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as ModelRuntimeMetadata;
}

function withTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}
