import { describe, expect, test } from 'bun:test';
import { __setMonitorRuntimeForTest, stopMonitor } from '@server/core/monitor';

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
});
