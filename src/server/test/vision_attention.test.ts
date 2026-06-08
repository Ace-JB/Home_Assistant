import { describe, expect, test } from 'bun:test';
import { VisionAttentionManager } from '@server/modules/vision/attention';

describe('VisionAttentionManager', () => {
    test('defaults to identity without persisted runtime state', () => {
        const manager = new VisionAttentionManager('identity');

        const snapshot = manager.snapshot(1000);

        expect(snapshot.activeProfile).toBe('identity');
        expect(snapshot.activeReason).toBe('baseline');
        expect(snapshot.hasActiveRequest).toBe(false);
        expect(snapshot.idleSince).toBe(1000);
        expect(snapshot.idleMs).toBe(0);
        expect(snapshot.requests).toHaveLength(0);
    });

    test('expires requests and falls back to identity', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'wake',
            source: 'wake',
            profile: 'perception',
            priority: 20,
            reason: 'wake_word_detected',
            ttlMs: 1000,
            now: 1000,
        });

        const activeSnapshot = manager.snapshot(1500);
        expect(activeSnapshot.activeProfile).toBe('perception');
        expect(activeSnapshot.hasActiveRequest).toBe(true);
        expect(activeSnapshot.idleSince).toBeNull();
        expect(activeSnapshot.idleMs).toBe(0);
        expect(manager.resolve(2000).activeProfile).toBe('identity');
        expect(manager.snapshot(2000).requests).toHaveLength(0);
    });

    test('snapshot reflects expired requests without explicit resolve', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'wake',
            source: 'wake',
            profile: 'perception',
            priority: 20,
            reason: 'wake_word_detected',
            ttlMs: 1000,
            now: 1000,
        });

        expect(manager.snapshot(2000).activeProfile).toBe('identity');
    });

    test('starts idle metadata when requests expire', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'wake',
            source: 'wake',
            profile: 'perception',
            priority: 20,
            reason: 'wake_word_detected',
            ttlMs: 1000,
            now: 1000,
        });

        const snapshot = manager.snapshot(2500);

        expect(snapshot.activeProfile).toBe('identity');
        expect(snapshot.hasActiveRequest).toBe(false);
        expect(snapshot.idleSince).toBe(2500);
        expect(snapshot.idleMs).toBe(0);
    });

    test('accumulates idle time while baseline has no active requests', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'wake',
            source: 'wake',
            profile: 'perception',
            priority: 20,
            reason: 'wake_word_detected',
            ttlMs: 1000,
            now: 1000,
        });
        manager.snapshot(2500);

        const snapshot = manager.snapshot(4000);

        expect(snapshot.idleSince).toBe(2500);
        expect(snapshot.idleMs).toBe(1500);
    });

    test('new requests reset idle metadata', () => {
        const manager = new VisionAttentionManager('identity');
        manager.snapshot(1000);
        manager.request({
            id: 'intent',
            source: 'intent',
            profile: 'full',
            priority: 80,
            reason: 'visual_question',
            ttlMs: 5000,
            now: 2000,
        });

        const snapshot = manager.snapshot(2500);

        expect(snapshot.activeProfile).toBe('full');
        expect(snapshot.hasActiveRequest).toBe(true);
        expect(snapshot.idleSince).toBeNull();
        expect(snapshot.idleMs).toBe(0);
    });

    test('higher priority request overrides lower priority request', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'wake',
            source: 'wake',
            profile: 'perception',
            priority: 20,
            reason: 'wake_word_detected',
            ttlMs: 5000,
            now: 1000,
        });
        manager.request({
            id: 'intent',
            source: 'intent',
            profile: 'full',
            priority: 80,
            reason: 'visual_question',
            ttlMs: 2000,
            now: 1100,
        });

        expect(manager.snapshot(1200).activeProfile).toBe('full');
        expect(manager.resolve(3100).activeProfile).toBe('perception');
    });

    test('same priority selects the stronger profile', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'ui',
            source: 'ui',
            profile: 'perception',
            priority: 30,
            reason: 'live_view_open',
            ttlMs: 5000,
            now: 1000,
        });
        manager.request({
            id: 'event',
            source: 'vision-event',
            profile: 'full',
            priority: 30,
            reason: 'uncertain_identity',
            ttlMs: 5000,
            now: 1001,
        });

        expect(manager.snapshot(1200).activeProfile).toBe('full');
    });

    test('clears requests by source', () => {
        const manager = new VisionAttentionManager('identity');
        manager.request({
            id: 'wake',
            source: 'wake',
            profile: 'perception',
            priority: 20,
            reason: 'wake_word_detected',
            ttlMs: 5000,
            now: 1000,
        });
        manager.request({
            id: 'intent',
            source: 'intent',
            profile: 'full',
            priority: 80,
            reason: 'visual_question',
            ttlMs: 5000,
            now: 1000,
        });

        manager.clearSource('intent', 1100);

        const snapshot = manager.snapshot(1100);
        expect(snapshot.activeProfile).toBe('perception');
        expect(snapshot.requests.map((request) => request.source)).toEqual(['wake']);
    });
});
