import { afterEach, describe, expect, test } from 'bun:test';
import {
    AssistantRuntimeService,
    __setAssistantRuntimeServiceForTest,
} from '@server/services/AssistantRuntimeService';
import {
    getDashboardStatus,
    startDashboardService,
    stopDashboardService,
} from '@server/services/DashboardService';

function createRuntime() {
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
        now: () => 5_000,
        log: () => undefined,
    });
    return { service, calls };
}

function serviceById(status: Awaited<ReturnType<typeof getDashboardStatus>>, id: string) {
    return status.services.find(service => service.id === id);
}

function serviceGroupById(status: Awaited<ReturnType<typeof getDashboardStatus>>, groupId: string) {
    return status.serviceGroups.find(group => group.id === groupId);
}

describe('Dashboard assistant runtime status', () => {
    afterEach(() => {
        __setAssistantRuntimeServiceForTest(null);
    });

    test('includes assistant-runtime and derives owned services from stopped runtime', async () => {
        const { service } = createRuntime();
        __setAssistantRuntimeServiceForTest(service);

        const status = await getDashboardStatus();

        expect(serviceById(status, 'assistant-runtime')).toMatchObject({
            status: 'stopped',
            actions: ['start'],
            controllable: true,
        });
        expect(serviceById(status, 'monitor')?.status).toBe('stopped');
        expect(serviceById(status, 'realtime-socket')?.status).toBe('stopped');
        expect(serviceById(status, 'webrtc')?.status).toBe('stopped');
    });

    test('groups service status into primary and advanced sections', async () => {
        const { service } = createRuntime();
        __setAssistantRuntimeServiceForTest(service);

        const status = await getDashboardStatus();

        expect(serviceGroupById(status, 'primary')?.collapsed).toBe(false);
        expect(serviceGroupById(status, 'primary')?.services.map(item => item.id)).toEqual([
            'main',
            'assistant-runtime',
            'voice-asr',
            'live-vision',
        ]);
        expect(serviceGroupById(status, 'advanced')?.collapsed).toBe(true);
        expect(serviceGroupById(status, 'advanced')?.services.map(item => item.id)).toEqual([
            'cosyvoice',
            'voice-separation',
            'ffmpeg',
            'yt-dlp',
            'realtime-socket',
            'webrtc',
        ]);
    });

    test('dashboard assistant-runtime actions delegate to runtime coordinator', async () => {
        const { service, calls } = createRuntime();
        __setAssistantRuntimeServiceForTest(service);

        const started = await startDashboardService('assistant-runtime');
        const stopped = await stopDashboardService('assistant-runtime');

        expect(started.status).toBe('running');
        expect(stopped.status).toBe('stopped');
        expect(calls).toEqual([
            'startFunASR',
            'startMonitor:audio',
            'stopMonitor',
            'stopRealtimeSocket',
            'stopWebRTC',
            'stopPythonServices',
        ]);
    });
});
