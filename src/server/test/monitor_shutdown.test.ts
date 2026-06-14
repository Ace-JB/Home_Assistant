import { describe, expect, test } from 'bun:test';
import {
    __setMonitorRuntimeForTest,
    __setMonitorStartersForTest,
    startMonitor,
    stopMonitor,
} from '@server/core/monitor';

describe('Monitor shutdown cleanup', () => {
    test('stopMonitor waits for in-flight startup and stops the created runtime', async () => {
        const events: string[] = [];
        let resolveStartup!: (runtime: { mode: 'full'; stop: () => Promise<void>; startedAt: number }) => void;
        const starting = new Promise<{ mode: 'full'; stop: () => Promise<void>; startedAt: number }>((resolve) => {
            resolveStartup = resolve;
        });

        __setMonitorRuntimeForTest({
            starting,
            runtime: undefined,
        });

        const stopped = stopMonitor();
        resolveStartup({
            mode: 'full',
            startedAt: Date.now(),
            stop: async () => {
                events.push('runtime.stop');
            },
        });

        await stopped;

        expect(events).toEqual(['runtime.stop']);
        __setMonitorRuntimeForTest({ runtime: undefined, starting: undefined });
    });

    test('startMonitor rethrows startup failures and clears the in-flight startup', async () => {
        const events: string[] = [];
        const originalError = console.error;

        __setMonitorRuntimeForTest({ runtime: undefined, starting: undefined });
        __setMonitorStartersForTest({
            audio: async () => {
                events.push('audio.fail');
                throw new Error('audio unavailable');
            },
        });

        try {
            console.error = () => undefined;
            await expect(startMonitor('audio')).rejects.toThrow('audio unavailable');
        } finally {
            console.error = originalError;
        }
        expect(events).toEqual(['audio.fail']);

        __setMonitorStartersForTest({
            audio: async () => {
                events.push('audio.ready');
                return async () => {
                    events.push('audio.stop');
                };
            },
        });

        await startMonitor('audio');
        await stopMonitor();

        expect(events).toEqual(['audio.fail', 'audio.ready', 'audio.stop']);
        __setMonitorStartersForTest(null);
        __setMonitorRuntimeForTest({ runtime: undefined, starting: undefined });
    });
});
