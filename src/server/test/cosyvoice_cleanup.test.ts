import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const restore = {
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    table: console.table,
};

describe('CosyVoice cleanup', () => {
    const oldEnv = { ...process.env };
    let tempRoot = '';

    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'ha-cosyvoice-cleanup-'));
        process.chdir(tempRoot);
        mkdirSync(join(tempRoot, 'data', 'voice', 'cosyvoice', 'uploads'), { recursive: true });
        mkdirSync(join(tempRoot, 'data', 'voice', 'cosyvoice', 'material-jobs'), { recursive: true });
        mkdirSync(join(tempRoot, 'data', 'voice', 'cosyvoice', 'speakers'), { recursive: true });
        process.env.COSYVOICE_DATA_ROOT = join(tempRoot, 'data', 'voice', 'cosyvoice');
        process.env.VOICE_DATA_ROOT = join(tempRoot, 'data', 'voice');
        process.env.NODE_ENV = 'test';
        process.env.SENTINEL_TTS_PROVIDER = 'cosyvoice';
        process.env.COSYVOICE_BASE_URL = 'http://localhost:50000';
        process.env.COSYVOICE_ENDPOINT = '/inference_zero_shot';
        process.env.COSYVOICE_TIMEOUT_MS = '1000';
        process.env.COSYVOICE_FALLBACK_TO_SAY = '0';
    });

    afterEach(() => {
        process.chdir(restore.cwd);
        process.env = { ...oldEnv };
        globalThis.fetch = restore.fetch;
        console.log = restore.log;
        console.info = restore.info;
        console.warn = restore.warn;
        console.error = restore.error;
        console.table = restore.table;
        if (tempRoot) {
            rmSync(tempRoot, { recursive: true, force: true });
            tempRoot = '';
        }
    });

    test('should save one canonical speaker prompt and remove temporary job files', async () => {
        const { saveCosyVoiceMaterial, getCosyVoiceMaterialConfig } = await import('@server/services/CosyVoiceMaterialService');

        const sourceAudioPath = join('data', 'voice', 'cosyvoice', 'material-jobs', 'sliced-audio', 'job-123', 'spk0-01.wav');
        const absoluteSourceAudioPath = join(tempRoot, sourceAudioPath);
        mkdirSync(join(absoluteSourceAudioPath, '..'), { recursive: true });
        writeFileSync(absoluteSourceAudioPath, 'wav-data');

        const speakerCache = new Map<string, string>();
        globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
            const target = String(url);
            if (target.endsWith('/speaker/cache')) {
                const form = init?.body as FormData;
                speakerCache.set('prompt', String(form.get('prompt_text') ?? ''));
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            return new Response(createSilentWav() as unknown as BodyInit, { status: 200 });
        }) as unknown as typeof fetch;

        const speaker = await saveCosyVoiceMaterial({
            provider: 'cosyvoice',
            baseUrl: 'http://localhost:50000',
            endpoint: '/inference_zero_shot',
            speakerName: 'Test Speaker',
            promptAudioPath: sourceAudioPath,
            promptText: '欢迎回家，我已经准备好了今天的计划。',
            timeoutMs: 1000,
            fallbackToSay: false,
        });

        expect(speaker.speaker.promptAudioPath).toContain(join('data', 'voice', 'cosyvoice', 'speakers'));
        expect(readFileSync(speaker.speaker.promptAudioPath, 'utf8')).toBe('wav-data');
        expect(() => readFileSync(absoluteSourceAudioPath, 'utf8')).toThrow();
        const selectedClipsDir = join(tempRoot, 'data', 'voice', 'cosyvoice', 'selected-clips');
        expect(existsSync(selectedClipsDir) ? readdirSync(selectedClipsDir) : []).toHaveLength(0);
        expect(readFileSync(join(tempRoot, 'data', 'voice', 'cosyvoice', 'wake-ack', 'wake-ack.wav')).byteLength).toBeGreaterThan(44);
        expect(getCosyVoiceMaterialConfig().promptAudioPath).toBe(speaker.speaker.promptAudioPath);
        expect(speakerCache.get('prompt')).toBe('欢迎回家，我已经准备好了今天的计划。');
    });

    test('should cleanup selected clip duplicates, stale assets, old jobs, and old source media', async () => {
        const { cleanupCosyVoiceMaterialStorage } = await import('@server/services/CosyVoiceMaterialService');

        const voiceRoot = join(tempRoot, 'data', 'voice');
        const cosyRoot = join(voiceRoot, 'cosyvoice');
        const assetsRoot = join(voiceRoot, 'assets');
        const speakerPath = join(cosyRoot, 'speakers', 'active.wav');
        const selectedDuplicate = join(cosyRoot, 'selected-clips', 'active-copy.wav');
        const selectedUnique = join(cosyRoot, 'selected-clips', 'keep-review.wav');
        const sourceMediaPath = join(cosyRoot, 'source-media', 'source-old.wav');
        const wakeAckPath = join(cosyRoot, 'wake-ack', 'wake-ack.wav');
        const jobPath = join(cosyRoot, 'material-jobs', 'sliced-audio', 'job-old', 'candidate.wav');
        const assetIndexPath = join(assetsRoot, 'index.json');
        const staleCandidatePath = join(cosyRoot, 'material-jobs', 'sliced-audio', 'missing-job', 'missing.wav');
        const temporaryCandidatePath = join(cosyRoot, 'material-jobs', 'sliced-audio', 'job-current', 'candidate.wav');

        mkdirSync(join(cosyRoot, 'speakers'), { recursive: true });
        mkdirSync(join(cosyRoot, 'selected-clips'), { recursive: true });
        mkdirSync(join(cosyRoot, 'source-media'), { recursive: true });
        mkdirSync(join(cosyRoot, 'wake-ack'), { recursive: true });
        mkdirSync(join(jobPath, '..'), { recursive: true });
        mkdirSync(join(temporaryCandidatePath, '..'), { recursive: true });
        mkdirSync(assetsRoot, { recursive: true });
        writeFileSync(speakerPath, 'canonical-wav');
        writeFileSync(selectedDuplicate, 'canonical-wav');
        writeFileSync(selectedUnique, 'review-copy');
        writeFileSync(sourceMediaPath, 'old-source');
        writeFileSync(wakeAckPath, 'wake-ack');
        writeFileSync(jobPath, 'candidate');
        writeFileSync(temporaryCandidatePath, 'temporary-candidate');
        writeFileSync(join(cosyRoot, 'speakers.json'), JSON.stringify([{
            id: 'active',
            name: 'Active',
            promptAudioPath: speakerPath,
            promptText: '欢迎回家，我已经准备好了今天的计划。',
            promptList: [{ id: 'prompt', audioPath: speakerPath, text: '欢迎回家，我已经准备好了今天的计划。', createdAt: '2026-01-01T00:00:00.000Z' }],
            benchmarkResults: [],
            cachedResponses: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }], null, 2));
        writeFileSync(assetIndexPath, JSON.stringify({
            assets: [
                { id: 'speaker-prompt-active', kind: 'speaker_prompt', path: speakerPath, createdAt: '2026-01-01T00:00:00.000Z' },
                { id: 'candidate-stale', kind: 'candidate', path: staleCandidatePath, createdAt: '2026-01-01T00:00:00.000Z' },
                { id: 'candidate-temporary', kind: 'candidate', path: temporaryCandidatePath, createdAt: '2026-01-01T00:00:00.000Z' },
            ],
            speakers: [],
            updatedAt: '2026-01-01T00:00:00.000Z',
        }, null, 2));

        const oldTime = new Date('2026-01-01T00:00:00.000Z');
        utimesSync(sourceMediaPath, oldTime, oldTime);
        utimesSync(jobPath, oldTime, oldTime);

        const result = await cleanupCosyVoiceMaterialStorage({
            now: new Date('2026-01-03T00:00:00.000Z').getTime(),
            jobTtlMs: 60_000,
            sourceTtlMs: 60_000,
        });

        expect(result.removedSelectedClipDuplicates).toBe(1);
        expect(existsSync(selectedDuplicate)).toBe(false);
        expect(existsSync(selectedUnique)).toBe(true);
        expect(existsSync(sourceMediaPath)).toBe(false);
        expect(existsSync(jobPath)).toBe(false);
        expect(existsSync(temporaryCandidatePath)).toBe(true);
        expect(existsSync(speakerPath)).toBe(true);
        expect(existsSync(wakeAckPath)).toBe(true);

        const nextIndex = JSON.parse(readFileSync(assetIndexPath, 'utf8'));
        expect(nextIndex.assets.map((asset: { id: string }) => asset.id)).toEqual(['speaker-prompt-active']);
    });
});

function createSilentWav(): Buffer {
    const sampleRate = 24000;
    const durationMs = 500;
    const dataBytes = sampleRate * 2 * durationMs / 1000;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);
    return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}
