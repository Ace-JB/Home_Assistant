import { describe, expect, test } from 'bun:test';
import { resolveRealtimeSocketUrl } from '@/config/realtimeSocketUrl';

describe('realtime socket URL resolution', () => {
    test('uses configured socket URL when provided', () => {
        const url = resolveRealtimeSocketUrl({
            protocol: 'http:',
            hostname: 'localhost',
            port: '3000',
        }, 'ws://127.0.0.1:3010/ws/realtime');

        expect(url).toBe('ws://127.0.0.1:3010/ws/realtime');
    });

    test('falls back to current port plus one when socket URL is not configured', () => {
        const url = resolveRealtimeSocketUrl({
            protocol: 'http:',
            hostname: 'localhost',
            port: '4000',
        }, '');

        expect(url).toBe('ws://localhost:4001/ws/realtime');
    });

    test('uses secure websocket fallback for https pages without explicit port', () => {
        const url = resolveRealtimeSocketUrl({
            protocol: 'https:',
            hostname: 'home.local',
            port: '',
        }, undefined);

        expect(url).toBe('wss://home.local:444/ws/realtime');
    });
});
