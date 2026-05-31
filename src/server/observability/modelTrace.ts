import { GLOBAL_CONFIG } from '@/global_config';

type TracePayload = unknown;

export function traceModelDecision(scope: string, event: string, payload: TracePayload): void {
    if (!GLOBAL_CONFIG.OLLAMA.TRACE_ENABLED) {
        return;
    }

    const formatted = formatTracePayload(payload);
    console.log(`[ModelTrace:${scope}] ${event}: ${formatted}`);
}

function formatTracePayload(payload: TracePayload): string {
    const raw = typeof payload === 'string'
        ? payload
        : JSON.stringify(payload, null, 2);
    const maxChars = GLOBAL_CONFIG.OLLAMA.TRACE_MAX_CHARS;

    if (raw.length <= maxChars) {
        return raw;
    }

    return `${raw.slice(0, maxChars)}... [truncated ${raw.length - maxChars} chars]`;
}
