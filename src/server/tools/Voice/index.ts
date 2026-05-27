import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { Readable } from 'stream';
import { GLOBAL_CONFIG } from '@/global_config';
import { funasrService } from '@/server/services/FunASRService';

type ProcessResult = {
    stdout: string;
    stderr: string;
};

export type InterruptibleSpeech = {
    done: Promise<void>;
    stop: () => void;
};

/**
 * 初始化麦克风音频流 (生产者函数)
 */
export async function initAudioListen(): Promise<{ stream: Readable; stop: () => Promise<void> }> {
    const outputStream = new PassThrough();
    let ffmpegProcess: ChildProcess | null = null;

    // 预热 FunASR Service
    void funasrService.start().catch(e => console.error('FunASR prewarm failed:', e));

    return new Promise((resolve, reject) => {
        let settled = false;
        const stderrChunks: Buffer[] = [];
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            ffmpegProcess?.kill('SIGTERM');
            outputStream.destroy();
            reject(new Error(`Audio did not produce samples within ${GLOBAL_CONFIG.FFMPEG.STARTUP_TIMEOUT_MS}ms.`));
        }, GLOBAL_CONFIG.FFMPEG.STARTUP_TIMEOUT_MS);

        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            outputStream.destroy();
            reject(err);
        };

        ffmpegProcess = spawn(GLOBAL_CONFIG.FFMPEG.BIN, [
            '-hide_banner',
            '-loglevel', 'warning',
            '-f', 'avfoundation', '-i', GLOBAL_CONFIG.VOICE.DEVICE,
            '-c:a', 'pcm_s16le', '-ar', GLOBAL_CONFIG.VOICE.SAMPLE_RATE, '-ac', '1', '-f', 's16le',
            'pipe:1'
        ]);

        ffmpegProcess.on('error', (err) => {
            fail(new Error(`Failed to start ffmpeg for audio: ${err.message}`));
        });

        ffmpegProcess.stderr?.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });

        outputStream.once('data', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            console.log(`🎙️ Audio stream started via ${GLOBAL_CONFIG.FFMPEG.BIN} device ${GLOBAL_CONFIG.VOICE.DEVICE}`);
            resolve({
                stream: outputStream,
                stop: async () => {
                    if (ffmpegProcess) {
                        return new Promise((res) => {
                            ffmpegProcess!.once('exit', () => res());
                            ffmpegProcess!.kill('SIGTERM');
                            ffmpegProcess = null;
                        });
                    }
                }
            });
        });

        ffmpegProcess.once('exit', (code, signal) => {
            if (settled) return;
            const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
            fail(new Error(`Audio ffmpeg exited early (code=${code}, signal=${signal}).${stderr}`));
        });

        ffmpegProcess.stdout?.pipe(outputStream);
    });
}

export async function extractTextFromVoiceStream(audio: Buffer): Promise<string> {
    if (audio.length === 0) {
        return '';
    }
    if (!isLikelySpeechAudio(audio)) {
        return '';
    }

    const sessionDir = await fs.mkdtemp(join(tmpdir(), 'ha-voice-'));
    const wavPath = join(sessionDir, 'audio.wav');

    const startTime = Date.now();
    try {
        await convertPcmToWav(audio, wavPath);

        // 使用常驻 Service 进行识别
        const transcript = await funasrService.transcribe(wavPath);
        const cleaned = normalizeTranscript(transcript);

        const duration = Date.now() - startTime;
        if (cleaned) {
            console.log(`[FunASR] Transcription took ${duration}ms: "${cleaned}"`);
        }

        return cleaned;
    } catch (error) {
        console.error('[FunASR] Error during transcription:', error);
        throw error;
    } finally {
        await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { });
    }
}

function isLikelySpeechAudio(audio: Buffer): boolean {
    const sampleRate = Number(GLOBAL_CONFIG.VOICE.SAMPLE_RATE);
    const durationMs = sampleRate > 0 ? (audio.length / 2 / sampleRate) * 1000 : 0;
    if (durationMs < 250) {
        return false;
    }

    let peak = 0;
    let sumSquares = 0;
    let samples = 0;
    for (let offset = 0; offset + 1 < audio.length; offset += 2) {
        const sample = audio.readInt16LE(offset) / 32768;
        const abs = Math.abs(sample);
        peak = Math.max(peak, abs);
        sumSquares += sample * sample;
        samples++;
    }
    const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
    return peak >= 0.02 && rms >= 0.003;
}

async function convertPcmToWav(audio: Buffer, wavPath: string): Promise<void> {
    await runProcess(
        GLOBAL_CONFIG.FFMPEG.BIN,
        [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-f', 's16le',
            '-ar', GLOBAL_CONFIG.VOICE.SAMPLE_RATE,
            '-ac', '1',
            '-i', 'pipe:0',
            '-c:a', 'pcm_s16le',
            wavPath,
        ],
        audio
    );
}

function runProcess(command: string, args: string[], input?: Buffer): Promise<ProcessResult> {
    return new Promise((resolveProcess, reject) => {
        const child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk);
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(new Error(`Failed to start ${command}: ${error.message}`));
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;

            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');

            if (code === 0) {
                resolveProcess({ stdout, stderr });
                return;
            }

            reject(new Error(`${command} exited with code=${code}, signal=${signal}.${stderr ? `\n${stderr.trim()}` : ''}`));
        });

        if (input) {
            child.stdin.end(input);
        } else {
            child.stdin.end();
        }
    });
}

export function normalizeTranscript(transcript: string): string {
    const garbagePatterns = [
        '请用简体中文清晰地回答',
        'please answer clearly in english',
        'answer clearly in english',
        '点赞', '订阅', '转发', '打赏',
        '谢谢大家', '字幕由', '字幕製作',
        'funasr', 'modelscope', 'version:', 'downloading', 'directory:', 'http',
        '明镜与点点', '貝爾', '12號', '快點', '我還沒吃完', '我去看看'
    ];

    const cleaned = transcript
        .split('\n')
        .map((line) => {
            if (garbagePatterns.some(p => line.toLowerCase().includes(p))) return '';

            let processed = line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim();
            processed = processed.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '').trim();
            return processed;
        })
        .filter((line) => line.length > 1)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned;
}

export function calculateTextSimilarity(a: string, b: string): number {
    const left = tokenizeForSimilarity(a);
    const right = tokenizeForSimilarity(b);
    if (left.length === 0 || right.length === 0) return 0;

    const leftSet = new Set(left);
    const rightSet = new Set(right);
    let intersection = 0;
    for (const token of leftSet) {
        if (rightSet.has(token)) intersection++;
    }

    return intersection / Math.min(leftSet.size, rightSet.size);
}

export function isEchoLikeTranscript(transcript: string, spokenText: string, threshold: number): boolean {
    return calculateTextSimilarity(transcript, spokenText) >= threshold;
}

export function hasBargeInKeyword(transcript: string, keywords: readonly string[]): boolean {
    const normalized = transcript.trim();
    const lower = normalized.toLowerCase();
    return keywords.some(keyword => {
        const item = keyword.trim().toLowerCase();
        return item.length > 0 && lower.includes(item);
    });
}

export function isValidBargeInTranscript(
    transcript: string,
    wakeWord: string,
    keywords: readonly string[] = [],
): boolean {
    const normalized = transcript.trim();
    if (hasBargeInKeyword(normalized, keywords)) return true;
    if (normalized.length < 2) return false;
    if (normalized === wakeWord) return false;
    if (/^(嗯+|啊+|哦+|呃+|额+|唔+|喂+|hi|hey|um+|uh+)$/i.test(normalized)) return false;
    return true;
}

function tokenizeForSimilarity(value: string): string[] {
    const normalized = value.toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, ' ');
    const words = normalized
        .split(/\s+/)
        .map(item => item.trim())
        .filter(item => item.length > 1);
    const cjkBigrams = Array.from(normalized.matchAll(/[\p{Script=Han}]{2,}/gu))
        .flatMap(match => {
            const chars = Array.from(match[0]);
            const bigrams: string[] = [];
            for (let index = 0; index < chars.length - 1; index++) {
                bigrams.push(`${chars[index]}${chars[index + 1]}`);
            }
            return bigrams;
        });

    return [...words, ...cjkBigrams];
}

export function speakInterruptible(text: string, options: { rate?: number; voice?: string } = {}): InterruptibleSpeech {
    const { rate = 180, voice = 'Tingting' } = options;
    const cleanedText = cleanSpeechText(text);

    if (!cleanedText) {
        return {
            done: Promise.resolve(),
            stop: () => undefined,
        };
    }

    const child = spawn('say', ['-v', voice, '-r', String(rate), cleanedText], {
        stdio: 'ignore',
    });
    let stopped = false;

    const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (stopped || signal === 'SIGTERM' || code === 0) {
                resolve();
                return;
            }
            reject(new Error(`say exited with code=${code}, signal=${signal}`));
        });
    });

    return {
        done,
        stop: () => {
            stopped = true;
            if (!child.killed) {
                child.kill('SIGTERM');
            }
        },
    };
}

export async function speak(text: string, options: { rate?: number; voice?: string } = {}): Promise<void> {
    return speakInterruptible(text, options).done;
}

function cleanSpeechText(text: string): string {
    return text
        .replace(/\([^)]*\)/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
