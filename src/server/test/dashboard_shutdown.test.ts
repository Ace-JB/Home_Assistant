import { describe, expect, test } from 'bun:test';
import { stopAllDashboardManagedServices } from '@server/services/DashboardService';

describe('Dashboard managed service shutdown', () => {
    test('stops all managed Python services through one shutdown entrypoint', async () => {
        const calls: string[] = [];

        await stopAllDashboardManagedServices({
            stopFunASR: async () => {
                calls.push('funasr');
            },
            stopCosyVoice: async () => {
                calls.push('cosyvoice');
            },
            stopMdx: async () => {
                calls.push('mdx');
            },
        });

        expect(calls).toEqual(['funasr', 'cosyvoice', 'mdx']);
    });
});
