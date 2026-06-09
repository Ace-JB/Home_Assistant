import { describe, expect, test } from 'bun:test';
import {
    CosyVoiceMaterialJobStore,
    parseYtDlpDownloadProgress,
} from '@server/services/cosyvoice/jobs';

describe('CosyVoice material jobs', () => {
    test('tracks running, succeeded, and failed stages immutably', () => {
        const store = new CosyVoiceMaterialJobStore({
            now: () => 1_000,
            maxJobs: 10,
            ttlMs: 60_000,
        });

        const job = store.createJob('probe-url', [
            { key: 'validate_url', percent: 10 },
            { key: 'yt_dlp_probe', percent: 80 },
            { key: 'parse_formats', percent: 95 },
            { key: 'done', percent: 100 },
        ]);

        expect(job).toMatchObject({
            type: 'probe-url',
            status: 'queued',
            percent: 0,
            stageKey: 'validate_url',
        });

        const running = store.updateStage(job.id, 'yt_dlp_probe', 'running yt-dlp');
        expect(running?.status).toBe('running');
        expect(running?.percent).toBe(80);
        expect(running?.stageKey).toBe('yt_dlp_probe');
        expect(running?.stages.find(stage => stage.key === 'yt_dlp_probe')).toMatchObject({
            status: 'running',
            detail: 'running yt-dlp',
        });
        expect(job.status).toBe('queued');

        const succeeded = store.succeed(job.id, { formats: [{ formatId: '140' }] }, [
            { key: 'yt_dlp_probe', label: 'Probe', durationMs: 123 },
        ]);
        expect(succeeded?.status).toBe('succeeded');
        expect(succeeded?.percent).toBe(100);
        expect(succeeded?.stageKey).toBe('done');
        expect(succeeded?.result).toEqual({ formats: [{ formatId: '140' }] });
        expect(succeeded?.timings).toEqual([{ key: 'yt_dlp_probe', label: 'Probe', durationMs: 123 }]);

        const failedJob = store.createJob('save', [
            { key: 'save_profile', percent: 30 },
            { key: 'done', percent: 100 },
        ]);
        const failed = store.fail(failedJob.id, new Error('cache failed'));
        expect(failed?.status).toBe('failed');
        expect(failed?.percent).toBe(100);
        expect(failed?.error).toBe('cache failed');
        expect(failed?.stages.find(stage => stage.key === 'save_profile')?.status).toBe('failed');
    });

    test('removes expired jobs and caps retained jobs', () => {
        let now = 1_000;
        const store = new CosyVoiceMaterialJobStore({
            now: () => now,
            maxJobs: 2,
            ttlMs: 50,
        });

        const first = store.createJob('probe-url', [{ key: 'done', percent: 100 }]);
        now = 1_010;
        const second = store.createJob('probe-url', [{ key: 'done', percent: 100 }]);
        now = 1_020;
        const third = store.createJob('probe-url', [{ key: 'done', percent: 100 }]);

        expect(store.getJob(first.id)).toBeNull();
        expect(store.getJob(second.id)?.id).toBe(second.id);
        expect(store.getJob(third.id)?.id).toBe(third.id);

        now = 1_100;
        store.cleanup();
        expect(store.getJob(second.id)).toBeNull();
        expect(store.getJob(third.id)).toBeNull();
    });

    test('reports running elapsed time and keeps completed stage duration', () => {
        let now = 1_000;
        const store = new CosyVoiceMaterialJobStore({
            now: () => now,
            maxJobs: 10,
            ttlMs: 60_000,
        });
        const job = store.createJob('import-url', [
            { key: 'validate_url', percent: 8 },
            { key: 'mdx_separation', percent: 56 },
            { key: 'done', percent: 100 },
        ]);

        now = 1_250;
        const running = store.updateStage(job.id, 'validate_url', 'checking url');
        expect(running?.stages.find(stage => stage.key === 'validate_url')).toMatchObject({
            status: 'running',
            detail: 'checking url',
            startedAt: new Date(1_250).toISOString(),
        });

        now = 2_750;
        const snapshot = store.getJob(job.id);
        expect(snapshot?.stages.find(stage => stage.key === 'validate_url')?.elapsedMs).toBe(1_500);

        now = 3_000;
        const completed = store.completeStage(job.id, 'validate_url', {
            key: 'validate_url',
            label: 'Validate URL',
            durationMs: 1_750,
        });
        const stage = completed?.stages.find(stage => stage.key === 'validate_url');
        expect(stage?.durationMs).toBe(1_750);
        expect(stage?.elapsedMs).toBeUndefined();
    });

    test('parses yt-dlp download percentages from stderr chunks', () => {
        expect(parseYtDlpDownloadProgress('[download]   4.2% of 10.00MiB at 1.00MiB/s ETA 00:09')).toBe(4.2);
        expect(parseYtDlpDownloadProgress('[download] 100% of 3.00MiB in 00:01')).toBe(100);
        expect(parseYtDlpDownloadProgress('Deleting original file')).toBeNull();
    });
});
