import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyAssistantVoiceConfig, getAssistantVoiceConfig, readAssistantVoiceBody } from '@server/services/AssistantConfigService';
import { GLOBAL_CONFIG } from '@/global_config';

const originalEnv = { ...process.env };
const originalVoice = { ...GLOBAL_CONFIG.VOICE };

afterEach(() => {
    process.env = { ...originalEnv };
    Object.assign(GLOBAL_CONFIG.VOICE, originalVoice);
});

describe('AssistantConfigService', () => {
    test('applies wake config to env file, process env, and global config immediately', async () => {
        const root = mkdtempSync(join(tmpdir(), 'assistant-config-'));
        const envPath = join(root, '.env.local');
        try {
            const config = await applyAssistantVoiceConfig({
                wakeWord: '小管家',
                wakeAckText: '来了',
                wakeAckFastReplyEnabled: false,
                bargeInEnabled: false,
            }, { envPath });

            expect(config).toEqual({
                wakeWord: '小管家',
                wakeAckText: '来了',
                wakeAckFastReplyEnabled: false,
                bargeInEnabled: false,
            });
            expect(getAssistantVoiceConfig().wakeWord).toBe('小管家');
            expect(process.env.SENTINEL_WAKE_WORD).toBe('小管家');
            expect(GLOBAL_CONFIG.VOICE.WAKE_WORD).toBe('小管家');
            expect(GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT).toBe('来了');
            expect(GLOBAL_CONFIG.VOICE.WAKE_ACK_FAST_REPLY_ENABLED).toBe(false);
            expect(GLOBAL_CONFIG.VOICE.BARGE_IN_ENABLED).toBe(false);

            const env = readFileSync(envPath, 'utf8');
            expect(env).toContain('SENTINEL_WAKE_WORD="小管家"');
            expect(env).toContain('SENTINEL_WAKE_ACK_TEXT="来了"');
            expect(env).toContain('SENTINEL_WAKE_ACK_FAST_REPLY_ENABLED=0');
            expect(env).toContain('SENTINEL_BARGE_IN_ENABLED=0');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('parses assistant voice request body booleans like env values', () => {
        expect(readAssistantVoiceBody({
            wakeWord: '管家',
            wakeAckText: '在',
            wakeAckFastReplyEnabled: '0',
            bargeInEnabled: 'false',
        })).toEqual({
            wakeWord: '管家',
            wakeAckText: '在',
            wakeAckFastReplyEnabled: false,
            bargeInEnabled: false,
        });
    });
});
