import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineLogService } from '@server/services/PipelineLogService';

describe('PipelineLogService', () => {
    test('creates a pipeline and records ordered events', () => {
        const service = new PipelineLogService();
        const pipeline = service.startPipeline({
            id: 'conversation-1',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-1',
            userCommand: '打开客厅灯',
        });

        service.appendEvent({
            pipelineId: pipeline.id,
            ts: 100,
            stage: 'asr',
            eventType: 'stage_complete',
            level: 'info',
            title: 'voice.command_captured',
            message: 'Voice command captured.',
            timings: [{ key: 'asr_transcribe', label: 'ASR', durationMs: 300 }],
        });
        service.appendEvent({
            pipelineId: pipeline.id,
            ts: 140,
            stage: 'intent',
            eventType: 'decision',
            level: 'warn',
            title: 'Intent routing',
        });

        const detail = service.getPipelineDetail('conversation-1');
        expect(detail?.eventCount).toBe(2);
        expect(detail?.severity).toBe('warn');
        expect(detail?.events.map(event => event.stage)).toEqual(['asr', 'intent']);
        expect(detail?.events[0]?.timings?.[0]?.durationMs).toBe(300);
    });

    test('records model calls and connects them to one pipeline', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'pipe-model',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-model',
        });
        service.recordModelCall({
            pipelineId: 'pipe-model',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            durationMs: 1200,
            inputChars: 100,
            outputChars: 40,
            promptPreview: 'prompt',
            outputPreview: 'answer',
        });

        const detail = service.getPipelineDetail('pipe-model');
        const modelCalls = service.listModelCalls({ pipelineId: 'pipe-model', limit: 10 });
        expect(detail?.modelCallCount).toBe(1);
        expect(modelCalls[0]?.scope).toBe('brain.response');
        expect(detail?.events.some(event => event.eventType === 'model_call')).toBe(true);
        expect('modelCalls' in (detail as object)).toBe(false);
        expect('incidents' in (detail as object)).toBe(false);
    });

    test('updates one model call row across its lifecycle', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'pipe-lifecycle',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-lifecycle',
        });
        const started = service.recordModelCall({
            id: 'model-lifecycle',
            pipelineId: 'pipe-lifecycle',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'started',
            inputChars: 1200,
            promptPreview: 'prompt preview',
            metadata: { traceId: 'trace-1', coldStart: true },
        });

        const completed = service.recordModelCall({
            id: started.id,
            pipelineId: 'pipe-lifecycle',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            durationMs: 900,
            outputChars: 80,
            outputPreview: 'answer preview',
            metadata: { coldStart: true },
        });

        const detail = service.getPipelineDetail('pipe-lifecycle');
        const modelCall = service.getModelCall('model-lifecycle');
        expect(completed.id).toBe(started.id);
        expect(detail?.modelCallCount).toBe(1);
        expect(detail?.eventCount).toBe(1);
        expect(modelCall?.status).toBe('complete');
        expect(modelCall?.durationMs).toBe(900);
        expect(detail?.events[0]?.title).toBe('Model call reference');
        expect((detail?.events[0]?.metadata as { modelCallId?: string } | undefined)?.modelCallId).toBe('model-lifecycle');
    });

    test('bounds model call metadata without corrupting json', () => {
        const service = new PipelineLogService();
        service.recordModelCall({
            pipelineId: 'pipe-long-metadata',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            metadata: {
                prompt: 'x'.repeat(20_000),
                nested: {
                    output: 'y'.repeat(20_000),
                    list: Array.from({ length: 80 }, (_, index) => ({ index, value: 'z'.repeat(200) })),
                },
            },
        });

        const record = service.listModelCalls({ pipelineId: 'pipe-long-metadata', limit: 1 })[0];
        expect(record?.metadata).toBeDefined();
        expect(JSON.stringify(record?.metadata).length).toBeGreaterThan(0);
        expect(JSON.stringify(record?.metadata)).toContain('truncated');
        expect(service.getPipelineDetail('pipe-long-metadata')).toBeNull();
    });

    test('keeps model call prompt and output text complete', () => {
        const service = new PipelineLogService();
        const prompt = `prompt-${'x'.repeat(20_000)}`;
        const output = `output-${'y'.repeat(20_000)}`;
        service.startPipeline({
            id: 'pipe-full-model-text',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-full-model-text',
        });
        service.recordModelCall({
            id: 'model-full-text',
            pipelineId: 'pipe-full-model-text',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            promptPreview: prompt,
            outputPreview: output,
        });

        const record = service.getModelCall('model-full-text');
        expect(record?.promptPreview).toBe(prompt);
        expect(record?.outputPreview).toBe(output);
        expect(record?.promptPreview).not.toContain('truncated');
        expect(record?.outputPreview).not.toContain('truncated');
    });

    test('does not write legacy runtime metadata fields', () => {
        const service = new PipelineLogService();
        const event = service.append({
            category: 'intent',
            title: 'intent.routing',
            level: 'info',
            message: 'routed',
            pipelineId: 'pipe-runtime-clean',
            conversationId: 'conversation-runtime-clean',
            metadata: { traceId: 'trace-runtime-clean' },
        });

        const metadata = event?.metadata as Record<string, unknown> | undefined;
        expect(metadata?.traceId).toBe('trace-runtime-clean');
        expect(metadata?.pipelineKind).toBe('conversation');
        expect(metadata).not.toHaveProperty('legacyCategory');
        expect(metadata).not.toHaveProperty('legacyTitle');
    });

    test('keeps unlinked wake diagnostics out of conversation pipelines', () => {
        const service = new PipelineLogService();
        service.appendEvent({
            pipelineId: 'wake-probe-1',
            stage: 'wake',
            eventType: 'stage_complete',
            level: 'debug',
            title: 'wake_word.not_detected',
            metadata: {
                pipelineKind: 'system',
                text: '国家的。',
                wakeWord: '管家',
            },
        });

        const pipeline = service.getPipeline('wake-probe-1');
        expect(pipeline?.kind).toBe('system');
        expect(pipeline?.conversationId).toBeUndefined();
    });

    test('gets one model call by id', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'pipe-single-model',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-single-model',
        });
        const created = service.recordModelCall({
            id: 'model-single',
            pipelineId: 'pipe-single-model',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            promptPreview: 'prompt',
            outputPreview: 'answer',
        });

        expect(service.getModelCall(created.id)?.scope).toBe('brain.response');
        expect(service.getModelCall('missing-model-call')).toBeNull();
    });

    test('removes one model call without removing its pipeline event', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'pipe-soft-model-link',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-soft-model-link',
        });
        const created = service.recordModelCall({
            id: 'model-soft-link',
            pipelineId: 'pipe-soft-model-link',
            stage: 'model',
            scope: 'brain.response',
            modelId: 'qwen',
            status: 'complete',
            durationMs: 800,
            promptPreview: 'prompt',
            outputPreview: 'answer',
        });

        expect(service.removeModelCall(created.id)).toBe(true);
        expect(service.removeModelCall(created.id)).toBe(false);
        expect(service.getModelCall(created.id)).toBeNull();

        const detail = service.getPipelineDetail('pipe-soft-model-link');
        expect(service.listModelCalls({ pipelineId: 'pipe-soft-model-link', limit: 10 })).toEqual([]);
        expect(detail?.modelCallCount).toBe(0);
        expect(detail?.events).toHaveLength(1);
        expect(detail?.events[0]?.eventType).toBe('model_call');
        expect((detail?.events[0]?.metadata as { modelCallId?: string } | undefined)?.modelCallId).toBe('model-soft-link');
    });

    test('removes one incident without removing its pipeline event', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'pipe-soft-incident-link',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-soft-incident-link',
        });
        const created = service.recordIncident({
            id: 'incident-soft-link',
            pipelineId: 'pipe-soft-incident-link',
            stage: 'intent',
            severity: 'warn',
            reason: 'model_repair_invalid',
            inputSnapshot: 'prompt',
            outputSnapshot: 'bad json',
        });

        expect(service.removeIncident(created.id)).toBe(true);
        expect(service.removeIncident(created.id)).toBe(false);
        expect(service.getIncident(created.id)).toBeNull();

        const detail = service.getPipelineDetail('pipe-soft-incident-link');
        expect(service.listIncidents({ pipelineId: 'pipe-soft-incident-link', limit: 10 })).toEqual([]);
        expect(detail?.incidentCount).toBe(0);
        expect(detail?.events).toHaveLength(1);
        expect(detail?.events[0]?.eventType).toBe('repair');
        expect((detail?.events[0]?.metadata as { incidentId?: string } | undefined)?.incidentId).toBe('incident-soft-link');
    });

    test('does not create a pipeline from unlinked model calls or incidents', () => {
        const service = new PipelineLogService();
        service.recordModelCall({
            pipelineId: 'trace-only',
            stage: 'model',
            scope: 'intention.routing',
            modelId: 'qwen',
            status: 'complete',
            promptPreview: 'prompt',
            outputPreview: 'decision',
        });
        service.recordIncident({
            pipelineId: 'trace-only-incident',
            stage: 'intent',
            severity: 'warn',
            reason: 'model_repair_invalid',
            outputSnapshot: 'bad json',
        });

        expect(service.getPipelineDetail('trace-only')).toBeNull();
        expect(service.getPipelineDetail('trace-only-incident')).toBeNull();
        expect(service.listPipelines({ limit: 10 })).toEqual([]);
        expect(service.listModelCalls({ pipelineId: 'trace-only', limit: 10 })).toHaveLength(1);
        expect(service.listIncidents({ pipelineId: 'trace-only-incident', limit: 10 })).toHaveLength(1);
    });

    test('normalizes system runtime logs into one system pipeline', () => {
        const service = new PipelineLogService();
        service.append({
            category: 'system',
            title: 'system.startup',
            message: 'Server ready',
            pipelineId: 'startup',
        });
        service.append({
            category: 'dashboard-service',
            title: 'service.start',
            message: 'FunASR ready',
            pipelineId: 'funasr',
        });

        const detail = service.getPipelineDetail('system');
        expect(detail?.kind).toBe('system');
        expect(detail?.events).toHaveLength(2);
        expect(detail?.events.map(event => event.title)).toEqual(['system.ready', 'system.component_ready']);
        expect(service.getPipelineDetail('startup')).toBeNull();
        expect(service.getPipelineDetail('funasr')).toBeNull();
    });

    test('records incidents for review', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'pipe-incident',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-incident',
        });
        service.recordIncident({
            pipelineId: 'pipe-incident',
            stage: 'intent',
            severity: 'error',
            reason: 'model_repair_error',
            inputSnapshot: { prompt: 'bad json' },
            outputSnapshot: 'repair failed',
            recommendedAction: 'tighten output schema',
        });

        const detail = service.getPipelineDetail('pipe-incident');
        const incidents = service.listIncidents({ pipelineId: 'pipe-incident', limit: 10 });
        expect(detail?.incidentCount).toBe(1);
        expect(detail?.severity).toBe('error');
        expect(incidents[0]?.reason).toBe('model_repair_error');
        expect(service.listIncidents({ limit: 10 })[0]?.recommendedAction).toBe('tighten output schema');
    });

    test('persists pipelines across service instances', () => {
        const dbPath = join(tmpdir(), `pipeline-logs-${crypto.randomUUID()}.sqlite`);
        const first = new PipelineLogService(20, dbPath);
        first.startPipeline({ id: 'persisted', kind: 'system', title: 'System pipeline' });
        first.appendEvent({
            pipelineId: 'persisted',
            stage: 'service',
            eventType: 'stage_complete',
            level: 'info',
            title: 'service started',
        });
        first.close();

        const second = new PipelineLogService(20, dbPath);
        expect(second.listPipelines({ limit: 10 }).map(entry => entry.id)).toEqual(['persisted']);
        expect(second.getPipelineDetail('persisted')?.events).toHaveLength(1);
        second.close();
    });

    test('removes a pipeline and its related rows', () => {
        const service = new PipelineLogService();
        service.startPipeline({
            id: 'drop-me',
            kind: 'conversation',
            title: 'Conversation pipeline',
            conversationId: 'conversation-drop',
        });
        service.recordModelCall({
            pipelineId: 'drop-me',
            scope: 'memory.prune',
            modelId: 'qwen',
            status: 'failed',
            error: 'boom',
        });

        expect(service.removePipeline('drop-me')).toBe(true);
        expect(service.getPipelineDetail('drop-me')).toBeNull();
        expect(service.listModelCalls({ pipelineId: 'drop-me', limit: 10 })).toEqual([]);
        expect(service.listIncidents({ pipelineId: 'drop-me', limit: 10 })).toEqual([]);
    });
});
