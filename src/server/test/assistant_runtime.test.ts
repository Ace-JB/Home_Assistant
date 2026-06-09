import { describe, expect, test } from 'bun:test';
import { AssistantRuntimeService, isAssistantRuntimeAvailable } from '@server/services/AssistantRuntimeService';

function createRuntime(overrides: Partial<ConstructorParameters<typeof AssistantRuntimeService>[0]> = {}) {
    const calls: string[] = [];
    const service = new AssistantRuntimeService({
        startMonitor: async (mode) => {
            calls.push(`startMonitor:${mode}`);
        },
        startFunASR: async () => {
            calls.push('startFunASR');
        },
        startCosyVoice: async () => {
            calls.push('startCosyVoice');
        },
        startVoiceSeparation: async () => {
            calls.push('startVoiceSeparation');
        },
        stopMonitor: async () => {
            calls.push('stopMonitor');
        },
        stopPythonServices: async () => {
            calls.push('stopPythonServices');
        },
        startWebRTC: () => {
            calls.push('startWebRTC');
        },
        stopRealtimeSocket: () => {
            calls.push('stopRealtimeSocket');
        },
        stopWebRTC: () => {
            calls.push('stopWebRTC');
        },
        now: () => 1_000,
        log: () => undefined,
        ...overrides,
    });
    return { service, calls };
}

describe('AssistantRuntimeService', () => {
    test('defaults to stopped and exposes start action', () => {
        const { service } = createRuntime();

        expect(service.getStatus()).toMatchObject({
            status: 'stopped',
            mode: 'minimal',
            activeMode: null,
            startedAt: null,
            uptimeSeconds: null,
            actions: ['start'],
            operation: null,
        });
    });

    test('starts minimal runtime by default without optional services', async () => {
        const { service, calls } = createRuntime();

        const status = await service.start();

        expect(calls).toEqual(['startFunASR', 'startMonitor:audio']);
        expect(status).toMatchObject({
            status: 'running',
            mode: 'minimal',
            activeMode: 'minimal',
            startedAt: 1_000,
            actions: ['stop'],
        });
        expect(status.tasks.find(task => task.id === 'webrtc')?.status).toBe('skipped');
        expect(status.tasks.find(task => task.id === 'cosyvoice')?.status).toBe('skipped');
        expect(status.tasks.find(task => task.id === 'voice-separation')?.status).toBe('skipped');
        expect(status.services.find(service => service.id === 'webrtc')?.status).toBe('stopped');
    });

    test('starts selected optional services and promotes live vision to full mode', async () => {
        const { service, calls } = createRuntime();

        const status = await service.start({
            optionalServices: ['cosyvoice', 'live-vision', 'voice-separation'],
        });

        expect(calls).toEqual([
            'startFunASR',
            'startCosyVoice',
            'startVoiceSeparation',
            'startWebRTC',
            'startMonitor:full',
        ]);
        expect(status.mode).toBe('full');
        expect(status.activeMode).toBe('full');
        expect(status.tasks.find(task => task.id === 'cosyvoice')?.status).toBe('ready');
        expect(status.tasks.find(task => task.id === 'voice-separation')?.status).toBe('ready');
        expect(status.tasks.find(task => task.id === 'webrtc')?.status).toBe('ready');
    });

    test('marks runtime error and cleans up when monitor startup fails', async () => {
        const { service, calls } = createRuntime({
            startMonitor: async () => {
                throw new Error('camera unavailable');
            },
        });

        const status = await service.start();

        expect(status.status).toBe('error');
        expect(status.lastError).toBe('camera unavailable');
        expect(calls).toEqual([
            'startFunASR',
            'stopMonitor',
            'stopRealtimeSocket',
            'stopWebRTC',
            'stopPythonServices',
        ]);
    });

    test('stops all runtime resources and is idempotent', async () => {
        const { service, calls } = createRuntime();

        await service.start();
        const stopped = await service.stop();
        const stoppedAgain = await service.stop();

        expect(calls).toEqual([
            'startFunASR',
            'startMonitor:audio',
            'stopMonitor',
            'stopRealtimeSocket',
            'stopWebRTC',
            'stopPythonServices',
        ]);
        expect(stopped.status).toBe('stopped');
        expect(stoppedAgain.status).toBe('stopped');
    });

    test('treats running and degraded as usable runtime states', () => {
        expect(isAssistantRuntimeAvailable('stopped')).toBe(false);
        expect(isAssistantRuntimeAvailable('starting')).toBe(false);
        expect(isAssistantRuntimeAvailable('running')).toBe(true);
        expect(isAssistantRuntimeAvailable('degraded')).toBe(true);
        expect(isAssistantRuntimeAvailable('error')).toBe(false);
    });
});
