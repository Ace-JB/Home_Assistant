import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import type { Readable } from 'stream';
import { GLOBAL_CONFIG } from '@/global_config';

/**
 * 初始化麦克风音频流 (生产者函数)
 */
export async function initAudioListen(): Promise<{ stream: Readable; stop: () => Promise<void> }> {
    const outputStream = new PassThrough();
    let ffmpegProcess: ChildProcess | null = null;

    return new Promise((resolve, reject) => {
        let settled = false;
        const stderrChunks: Buffer[] = [];
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            ffmpegProcess?.kill('SIGTERM');
            outputStream.destroy();
            reject(new Error(`Audio did not produce samples within ${GLOBAL_CONFIG.FFMPEG.STARTUP_TIMEOUT_MS}ms. Check microphone permission, device id (${GLOBAL_CONFIG.VOICE.DEVICE}), and ffmpeg availability.`));
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
            '-f', 'avfoundation', '-i', GLOBAL_CONFIG.VOICE.DEVICE, // 仅音频采集
            '-c:a', 'pcm_s16le', '-ar', GLOBAL_CONFIG.VOICE.SAMPLE_RATE, '-ac', '1', '-f', 's16le',
            'pipe:1'
        ]);

        ffmpegProcess.on('error', (err) => {
            fail(new Error(`Failed to start ffmpeg for audio: ${err.message}. Set FFMPEG_PATH or install ffmpeg.`));
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
            fail(new Error(`Audio ffmpeg exited before producing samples (code=${code}, signal=${signal}).${stderr ? `\n${stderr}` : ''}`));
        });

        ffmpegProcess.stdout?.pipe(outputStream);
    });
};

export function extractTextFromVoice() { };

export async function speak(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        exec(`say "${text}"`, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
};

await speak('1');
await speak('2');
await speak('3');
await speak('4');