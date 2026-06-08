import { describe, expect, test } from 'bun:test';
import { WebRTCManager } from '@tools/WebRTC';

describe('WebRTCManager cleanup', () => {
    test('stop keeps UDP socket available while shutdown closes it', () => {
        const events: string[] = [];
        const manager = new WebRTCManager({
            udpServer: {
                on: () => undefined,
                bind: (_port: number, _host: string, callback: () => void) => callback(),
                close: () => events.push('udp.close'),
                removeAllListeners: () => events.push('udp.removeAllListeners'),
            } as any,
        });

        manager.stop();
        expect(events).toEqual([]);

        manager.shutdown();
        expect(events).toEqual(['udp.removeAllListeners', 'udp.close']);
    });
});
