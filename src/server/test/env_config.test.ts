import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
    isManagedCosyVoiceAudioPath,
    parseFunASRMaterialCandidates,
    parseYtDlpAudioFormats,
    probeYtDlpAudioFormats,
} from '@server/services/CosyVoiceMaterialService';

describe('environment config files', () => {
    test('should define shared runtime keys in base env', () => {
        const content = readFileSync('.env', 'utf8');

        expect(content).toContain('NODE_ENV=');
        expect(content).toContain('VITE_API_BASE_URL=');
        expect(content).toContain('VITE_SOCKET_URL=');
        expect(content).toContain('SENTINEL_TTS_PROVIDER=');
        expect(content).toContain('COSYVOICE_BASE_URL=');
        expect(content).toContain('COSYVOICE_INSTALL_DIR=src/server/models/voice/CosyVoice3-MLX');
        expect(content).toContain('COSYVOICE_MODEL_DIR=mlx-community/Fun-CosyVoice3-0.5B-2512-4bit');
        expect(content).toContain('COSYVOICE_MLX_PACKAGE=mlx-audio-plus==0.1.8');
        expect(content).not.toContain('COSYVOICE_BACKEND=');
        expect(content).not.toContain('COSYVOICE_REPO_URL=');
        expect(content).toContain('COSYVOICE_PROMPT_AUDIO_PATH=');
        expect(content).toContain('COSYVOICE_PROMPT_TEXT=');
        expect(content).toContain('COSYVOICE_FALLBACK_TO_SAY=0');
        expect(content).toContain('FFMPEG_PATH=');
    });

    test('should keep CosyVoice runtime MLX-only', () => {
        const files = [
            '.env',
            '.env.example',
            'src/global_config.ts',
            'src/server/scripts/cosyvoice_common.ts',
            'src/server/scripts/install_cosyvoice.ts',
            'src/server/scripts/start_cosyvoice.ts',
        ];
        const content = files.map(file => readFileSync(file, 'utf8')).join('\n');

        expect(content).toContain('src/server/models/voice/CosyVoice3-MLX');
        expect(content).not.toContain('CosyVoice-300M');
        expect(content).not.toContain("backend: 'mlx' | 'pytorch'");
        expect(content).not.toContain("COSYVOICE_BACKEND");
        expect(content).not.toContain("COSYVOICE_REPO_URL");
    });

    test('should keep environment files focused on overrides', () => {
        const testEnv = readFileSync('.env.test', 'utf8');
        const prodEnv = readFileSync('.env.production', 'utf8');

        expect(testEnv).toContain('NODE_ENV=test');
        expect(testEnv).toContain('SENTINEL_TTS_PROVIDER=say');
        expect(testEnv).not.toContain('VITE_API_BASE_URL=');
        expect(testEnv).not.toContain('COSYVOICE_BASE_URL=');

        expect(prodEnv).toContain('NODE_ENV=production');
        expect(prodEnv).toContain('COSYVOICE_FALLBACK_TO_SAY=0');
        expect(prodEnv).not.toContain('VITE_SOCKET_URL=');
    });

    test('should restrict CosyVoice prompt audio to managed wav files', () => {
        expect(isManagedCosyVoiceAudioPath('data/cosyvoice/prompt-test.wav')).toBe(true);
        expect(isManagedCosyVoiceAudioPath('data/cosyvoice/uploads/source-test.mp4')).toBe(false);
        expect(isManagedCosyVoiceAudioPath('../outside.wav')).toBe(false);
        expect(isManagedCosyVoiceAudioPath('/tmp/outside.wav')).toBe(false);
    });

    test('should parse only audio-only formats from yt-dlp metadata', () => {
        const formats = parseYtDlpAudioFormats({
            formats: [
                {
                    format_id: 'audio-only',
                    ext: 'm4a',
                    resolution: 'audio only',
                    vcodec: 'none',
                    acodec: 'mp4a',
                    protocol: 'https',
                },
                {
                    format_id: '137',
                    ext: 'mp4',
                    height: 1080,
                    fps: 30,
                    vcodec: 'avc1',
                    acodec: 'none',
                    filesize: 1024 * 1024,
                    protocol: 'https',
                },
                {
                    format_id: '22',
                    ext: 'mp4',
                    resolution: '720p',
                    fps: 30,
                    vcodec: 'avc1',
                    acodec: 'mp4a',
                    filesize_approx: 2 * 1024 * 1024,
                    protocol: 'https',
                },
            ],
        });

        expect(formats).toHaveLength(1);
        expect(formats.map(format => format.formatId)).toEqual(['audio-only']);
        expect(formats[0]?.label).toContain('audio-only');
        expect(formats[0]?.label).toContain('mp4a');
        expect(formats[0]?.previewUrl).toBe('');
    });

    test('should filter FunASR material candidates for CosyVoice prompts', () => {
        const candidates = parseFunASRMaterialCandidates([
            { start_ms: 0, end_ms: 2500, text: '太短了', spk: 'SPK0' },
            { start_ms: 3000, end_ms: 8500, text: '欢迎回家，我已经准备好了今天的计划。', spk: 'SPK1' },
            { start_ms: 9000, end_ms: 20500, text: '这一段时间太长了不适合作为提示音频。', spk: 'SPK1' },
            { start_ms: 21000, end_ms: 26000, text: '谢谢观看', spk: 'SPK2' },
            { start_ms: 27000, end_ms: 32000, text: '好的，我会保持安静等待你的下一步指令。', spk: 'SPK1' },
            { start_ms: 31500, end_ms: 36000, text: '这段和前一段重叠。', spk: 'SPK3' },
        ]);

        expect(candidates.some(candidate => candidate.spk === 'SPK1' && candidate.text.includes('欢迎回家'))).toBe(true);
        expect(candidates.every(candidate => !candidate.text.includes('谢谢观看'))).toBe(true);
        expect(candidates.every(candidate => candidate.durationMs >= 3000 && candidate.durationMs <= 10000)).toBe(true);
        expect(candidates.every(candidate => candidate.score > 0)).toBe(true);
    });

    test('should reject candidates too close to another speaker', () => {
        const candidates = parseFunASRMaterialCandidates([
            { start_ms: 0, end_ms: 900, text: '第一句内容，', spk: 'SPK0' },
            { start_ms: 900, end_ms: 2100, text: '第二句内容，', spk: 'SPK0' },
            { start_ms: 2100, end_ms: 3400, text: '第三句内容。', spk: 'SPK0' },
            { start_ms: 3600, end_ms: 4300, text: '另一个人插话。', spk: 'SPK1' },
        ]);

        expect(candidates).toHaveLength(0);
    });

    test('should merge short adjacent segments only within the same speaker', () => {
        const candidates = parseFunASRMaterialCandidates([
            { start_ms: 270, end_ms: 770, text: '咕咕嘎，', spk: 'SPK0' },
            { start_ms: 850, end_ms: 1830, text: '昨天没穿衣服，', spk: 'SPK0' },
            { start_ms: 1830, end_ms: 2970, text: '我感觉有点不舒服，', spk: 'SPK0' },
            { start_ms: 2990, end_ms: 4170, text: '想去做个针灸兜肉，', spk: 'SPK0' },
            { start_ms: 4170, end_ms: 4890, text: '要不要陪我去啊？', spk: 'SPK0' },
            { start_ms: 5310, end_ms: 6130, text: '哪里不舒服呀，', spk: 'SPK1' },
        ]);

        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0]?.spk).toBe('SPK0');
        expect(candidates[0]?.durationMs).toBeGreaterThanOrEqual(3000);
        expect(candidates[0]?.text).toContain('昨天没穿衣服');
        expect(candidates[0]?.text).not.toContain('哪里不舒服');
    });

    test('should expose a preview URL for parsed yt-dlp audio formats', () => {
        const formats = parseYtDlpAudioFormats({
            formats: [
                {
                    format_id: '140',
                    ext: 'm4a',
                    vcodec: 'none',
                    acodec: 'mp4a',
                },
            ],
        }, 'https://example.com/watch?v=abc');

        expect(formats[0]?.previewUrl).toContain('/api/voice/cosyvoice/preview-url?');
        expect(formats[0]?.previewUrl).toContain('formatId=140');
    });

    test('should reject unsupported yt-dlp URL schemes before spawning', async () => {
        await expect(probeYtDlpAudioFormats('file:///tmp/video.mp4')).rejects.toThrow('Only http and https URLs are supported.');
    });

    test('should keep yt-dlp default install target under server tools bin', () => {
        const env = readFileSync('.env', 'utf8');

        expect(env).toContain('YT_DLP_BIN=src/server/tools/bin/yt-dlp');
    });
});
