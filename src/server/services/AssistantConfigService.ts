import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { GLOBAL_CONFIG, parseEnvBoolean } from '@/global_config';

export type AssistantVoiceConfig = {
    wakeWord: string;
    wakeAckText: string;
    wakeAckFastReplyEnabled: boolean;
    bargeInEnabled: boolean;
};

const MANAGED_ENV_KEYS = [
    'SENTINEL_WAKE_WORD',
    'SENTINEL_WAKE_ACK_TEXT',
    'SENTINEL_WAKE_ACK_FAST_REPLY_ENABLED',
    'SENTINEL_BARGE_IN_ENABLED',
];

export function getAssistantVoiceConfig(): AssistantVoiceConfig {
    return {
        wakeWord: GLOBAL_CONFIG.VOICE.WAKE_WORD,
        wakeAckText: GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT,
        wakeAckFastReplyEnabled: GLOBAL_CONFIG.VOICE.WAKE_ACK_FAST_REPLY_ENABLED,
        bargeInEnabled: GLOBAL_CONFIG.VOICE.BARGE_IN_ENABLED,
    };
}

export async function applyAssistantVoiceConfig(
    input: Partial<AssistantVoiceConfig>,
    options: { envPath?: string } = {},
): Promise<AssistantVoiceConfig> {
    const normalized = normalizeAssistantVoiceConfig({
        ...getAssistantVoiceConfig(),
        ...input,
    });

    await updateEnvLocal({
        SENTINEL_WAKE_WORD: normalized.wakeWord,
        SENTINEL_WAKE_ACK_TEXT: normalized.wakeAckText,
        SENTINEL_WAKE_ACK_FAST_REPLY_ENABLED: normalized.wakeAckFastReplyEnabled ? '1' : '0',
        SENTINEL_BARGE_IN_ENABLED: normalized.bargeInEnabled ? '1' : '0',
    }, options.envPath);

    process.env.SENTINEL_WAKE_WORD = normalized.wakeWord;
    process.env.SENTINEL_WAKE_ACK_TEXT = normalized.wakeAckText;
    process.env.SENTINEL_WAKE_ACK_FAST_REPLY_ENABLED = normalized.wakeAckFastReplyEnabled ? '1' : '0';
    process.env.SENTINEL_BARGE_IN_ENABLED = normalized.bargeInEnabled ? '1' : '0';

    GLOBAL_CONFIG.VOICE.WAKE_WORD = normalized.wakeWord;
    GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT = normalized.wakeAckText;
    GLOBAL_CONFIG.VOICE.WAKE_ACK_FAST_REPLY_ENABLED = normalized.wakeAckFastReplyEnabled;
    GLOBAL_CONFIG.VOICE.BARGE_IN_ENABLED = normalized.bargeInEnabled;

    return getAssistantVoiceConfig();
}

function normalizeAssistantVoiceConfig(config: AssistantVoiceConfig): AssistantVoiceConfig {
    const wakeWord = config.wakeWord.trim();
    const wakeAckText = config.wakeAckText.trim();
    if (!wakeWord) {
        throw new Error('wakeWord is required.');
    }
    if (wakeWord.length > 24) {
        throw new Error('wakeWord must be 24 characters or fewer.');
    }
    if (!wakeAckText) {
        throw new Error('wakeAckText is required.');
    }
    return {
        wakeWord,
        wakeAckText,
        wakeAckFastReplyEnabled: Boolean(config.wakeAckFastReplyEnabled),
        bargeInEnabled: Boolean(config.bargeInEnabled),
    };
}

async function updateEnvLocal(values: Record<string, string>, configuredEnvPath?: string): Promise<void> {
    const envPath = resolve(configuredEnvPath ?? '.env.local');
    const lines = existsSync(envPath)
        ? (await readFile(envPath, 'utf8')).split(/\r?\n/)
        : [];
    const nextLines: string[] = [];
    const written = new Set<string>();

    for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        const key = match?.[1];
        if (key && MANAGED_ENV_KEYS.includes(key)) {
            if (!written.has(key)) {
                nextLines.push(`${key}=${formatEnvValue(values[key] ?? '')}`);
                written.add(key);
            }
            continue;
        }
        nextLines.push(line);
    }

    for (const key of MANAGED_ENV_KEYS) {
        if (!written.has(key)) {
            nextLines.push(`${key}=${formatEnvValue(values[key] ?? '')}`);
        }
    }

    await writeFile(envPath, `${nextLines.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
}

function formatEnvValue(value: string): string {
    if (/^[A-Za-z0-9_./: -]*$/u.test(value) && !value.includes('\n')) {
        return value;
    }
    return JSON.stringify(value);
}

export function readAssistantVoiceBody(body: unknown): Partial<AssistantVoiceConfig> {
    if (!body || typeof body !== 'object') return {};
    const record = body as Record<string, unknown>;
    return {
        ...(typeof record.wakeWord === 'string' ? { wakeWord: record.wakeWord } : {}),
        ...(typeof record.wakeAckText === 'string' ? { wakeAckText: record.wakeAckText } : {}),
        ...(record.wakeAckFastReplyEnabled !== undefined ? { wakeAckFastReplyEnabled: parseEnvBoolean(String(record.wakeAckFastReplyEnabled), true) } : {}),
        ...(record.bargeInEnabled !== undefined ? { bargeInEnabled: parseEnvBoolean(String(record.bargeInEnabled), true) } : {}),
    };
}
