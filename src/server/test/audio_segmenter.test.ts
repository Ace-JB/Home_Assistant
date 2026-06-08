import { describe, expect, test } from 'bun:test';
import { AudioSegmenter, type AudioSegmenterConfig } from '@server/services/audio/AudioSegmenter';

const baseConfig: AudioSegmenterConfig = {
    speechThreshold: 0.02,
    startFrames: 2,
    endFrames: 3,
    softMaxDurationMs: 1_000,
    hardMaxDurationMs: 1_500,
    cooldownMs: 0,
};

const frame = Buffer.alloc(320);

describe('AudioSegmenter', () => {
    test('forces a segment to end when active audio exceeds hard max duration', () => {
        const segmenter = new AudioSegmenter(baseConfig);
        let segment = null;

        for (let index = 0; index < 20; index++) {
            segment = segmenter.push(frame, { peak: 0.04, rms: 0.01 }, index * 100);
            if (segment) break;
        }

        expect(segment).toBeTruthy();
        expect(segment!.endReason).toBe('hard_max_duration');
        expect(segment!.forced).toBe(true);
        expect(segment!.segmentEndTs - segment!.segmentStartTs).toBeGreaterThanOrEqual(baseConfig.hardMaxDurationMs);
    });

    test('ignores short noise spikes before speech is confirmed', () => {
        const segmenter = new AudioSegmenter(baseConfig);

        segmenter.push(frame, { peak: 0.05, rms: 0.01 }, 100);
        segmenter.push(frame, { peak: 0.001, rms: 0.001 }, 200);

        expect(segmenter.getState()).toBe('idle');
        expect(segmenter.getBufferedFrameCount()).toBe(0);
    });

    test('ends confirmed speech after consecutive silence frames', () => {
        const segmenter = new AudioSegmenter(baseConfig);

        segmenter.push(frame, { peak: 0.05, rms: 0.01 }, 100);
        segmenter.push(frame, { peak: 0.05, rms: 0.01 }, 200);
        segmenter.push(frame, { peak: 0.001, rms: 0.001 }, 300);
        segmenter.push(frame, { peak: 0.001, rms: 0.001 }, 400);
        const segment = segmenter.push(frame, { peak: 0.001, rms: 0.001 }, 500);

        expect(segment?.endReason).toBe('silence');
        expect(segment?.forced).toBe(false);
        expect(segment?.activeFrameCount).toBe(2);
    });
});
