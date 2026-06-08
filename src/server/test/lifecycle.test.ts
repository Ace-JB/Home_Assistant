import { describe, expect, test } from 'bun:test';
import { LifecycleManager } from '@server/core/lifecycle';

describe('LifecycleManager', () => {
    test('runs shutdown tasks once in registration order and exits after cleanup', async () => {
        const events: string[] = [];
        const exits: number[] = [];
        const manager = new LifecycleManager({
            exit: (code) => exits.push(code),
            logger: { log: () => undefined, error: () => undefined, warn: () => undefined },
        });

        manager.registerShutdownTask('first', async () => {
            events.push('first');
        });
        manager.registerShutdownTask('second', async () => {
            events.push('second');
        });

        await Promise.all([
            manager.shutdown('SIGTERM'),
            manager.shutdown('SIGINT'),
        ]);

        expect(events).toEqual(['first', 'second']);
        expect(exits).toEqual([0]);
    });

    test('continues later shutdown tasks after one task fails', async () => {
        const events: string[] = [];
        const exits: number[] = [];
        const errors: string[] = [];
        const manager = new LifecycleManager({
            exit: (code) => exits.push(code),
            logger: {
                log: () => undefined,
                warn: () => undefined,
                error: (...args) => errors.push(args.map(String).join(' ')),
            },
        });

        manager.registerShutdownTask('bad', async () => {
            events.push('bad');
            throw new Error('boom');
        });
        manager.registerShutdownTask('good', async () => {
            events.push('good');
        });

        await manager.shutdown('ERROR');

        expect(events).toEqual(['bad', 'good']);
        expect(exits).toEqual([1]);
        expect(errors.some((message) => message.includes('bad'))).toBe(true);
    });
});
