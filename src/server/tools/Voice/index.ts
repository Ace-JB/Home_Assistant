import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import type { Readable } from 'stream';
import { GLOBAL_CONFIG } from '@/global_config';

type ProcessResult = {
    stdout: string;
    stderr: string;
};

/**
 * FunASR 常驻服务管理类
 * 避免每次识别都重新加载模型 (耗时 6s+)，改为加载一次常驻内存
 */
class FunASRWorker {
    private process: ChildProcess | null = null;
    private isReady = false;
    private pendingResolver: ((text: string) => void) | null = null;
    private startPromise: Promise<void> | null = null;

    async ensureStarted() {
        if (this.isReady) return;
        if (this.startPromise) return this.startPromise;

        this.startPromise = new Promise<void>((resolve, reject) => {
            const cmdParts = GLOBAL_CONFIG.VOICE.FUNASR_CMD.split(' ');
            const cmd = cmdParts[0]!;
            const baseArgs = cmdParts.slice(1);

            console.log('⏳ Loading FunASR model into memory...');

            this.process = spawn(cmd, [
                ...baseArgs,
                '--model', GLOBAL_CONFIG.VOICE.FUNASR_MODEL,
                '--cache', GLOBAL_CONFIG.MODELS.BASE_PATH,
            ]);

            const timeout = setTimeout(() => {
                reject(new Error('FunASR Worker startup timeout (60s)'));
            }, 60000);

            this.process.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === 'READY') {
                        clearTimeout(timeout);
                        this.isReady = true;
                        console.log('✅ FunASR Worker Ready (Model Loaded)');
                        resolve();
                    } else if (trimmedLine.startsWith('RESULT:')) {
                        const text = trimmedLine.replace('RESULT:', '').trim();
                        if (this.pendingResolver) {
                            this.pendingResolver(text);
                            this.pendingResolver = null;
                        }
                    } else if (trimmedLine.startsWith('ERROR:')) {
                        console.error('[FunASR Worker Error]', trimmedLine);
                        if (this.pendingResolver) {
                            this.pendingResolver('');
                            this.pendingResolver = null;
                        }
                    }
                }
            });

            this.process.stderr?.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) console.error(`[FunASR Stderr] ${msg}`);
            });

            this.process.on('exit', (code) => {
                console.warn(`⚠️ FunASR Worker exited with code ${code}`);
                this.isReady = false;
                this.process = null;
                this.startPromise = null;
            });
        });

        return this.startPromise;
    }

    async transcribe(wavPath: string): Promise<string> {
        await this.ensureStarted();
        return new Promise((resolve) => {
            if (!this.process || !this.process.stdin) {
                resolve('');
                return;
            }
            this.pendingResolver = resolve;
            this.process.stdin.write(`${wavPath}\n`);
        });
    }
}

const funasrWorker = new FunASRWorker();

/**
 * 初始化麦克风音频流 (生产者函数)
 */
export async function initAudioListen(): Promise<{ stream: Readable; stop: () => Promise<void> }> {
    const outputStream = new PassThrough();
    let ffmpegProcess: ChildProcess | null = null;

    // 预热 FunASR Worker
    void funasrWorker.ensureStarted().catch(e => console.error('FunASR prewarm failed:', e));

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

        // 使用常驻 Worker 进行识别
        const transcript = await funasrWorker.transcribe(wavPath);
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
    const { rate = 175, voice } = options;
    const voiceArg = voice ? `-v "${voice}"` : '';

    return new Promise((resolve, reject) => {
        const safeText = text.replace(/"/g, '\\"');
        exec(`say ${voiceArg} -r ${rate} "${safeText}"`, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
