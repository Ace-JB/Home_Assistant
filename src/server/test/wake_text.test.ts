import { describe, expect, test } from 'bun:test';
import { extractWakeCommand, hasMeaningfulWakeCommand, hasWakeWordInText } from '@server/services/audio/wakeText';

describe('wake text helpers', () => {
    test('extracts only the command after the wake word', () => {
        const result = extractWakeCommand('那个九九九九管家红烧牛肉怎么做？喵喵喵', '管家');

        expect(result.hasWakeWord).toBe(true);
        expect(result.prefixNoiseChars).toBeGreaterThan(0);
        expect(result.command).toBe('红烧牛肉怎么做？喵喵喵');
        expect(hasMeaningfulWakeCommand(result.command)).toBe(true);
    });

    test('detects wake word through normalized text', () => {
        expect(hasWakeWordInText('管-家', '管家')).toBe(true);
        expect(extractWakeCommand('管-家 打开灯', '管家').command).toBe('打开灯');
    });

    test('returns no command when wake word is absent', () => {
        const result = extractWakeCommand('红烧牛肉怎么做', '管家');

        expect(result.hasWakeWord).toBe(false);
        expect(result.command).toBe('');
    });
});
