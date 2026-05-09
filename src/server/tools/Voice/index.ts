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

export async function speak(text: string, options: { rate?: number; voice?: string } = {}): Promise<void> {
    const { rate = 180, voice = 'Tingting' } = options;
    const voiceArg = `-v "${voice}"`;

    // 预处理文本：移除括号内的英文（防止 TTS 语调突变），移除多余空格
    const cleanedText = text
        .replace(/\([^)]*\)/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleanedText) return;

    return new Promise((resolve, reject) => {
        const safeText = cleanedText.replace(/"/g, '\\"');
        exec(`say ${voiceArg} -r ${rate} "${safeText}"`, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
