import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import type { Readable } from 'stream';
import { GLOBAL_CONFIG } from '@/global_config';

/**
 * 初始化摄像头视频流 (生产者函数)
 */
export async function initCamera(
    width: number = GLOBAL_CONFIG.VIDEO.WIDTH,
    height: number = GLOBAL_CONFIG.VIDEO.HEIGHT
): Promise<{ stream: Readable; stop: () => Promise<void> }> {
    const outputStream = new PassThrough(); // 创建一个中转流用于外部消费
    let ffmpegProcess: ChildProcess | null = null;
    const fps = String(GLOBAL_CONFIG.VIDEO.FPS);

    return new Promise((resolve, reject) => {
        let settled = false;
        const stderrChunks: Buffer[] = [];
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            ffmpegProcess?.kill('SIGTERM');
            outputStream.destroy();
            reject(new Error(`Camera did not produce frames within ${GLOBAL_CONFIG.FFMPEG.STARTUP_TIMEOUT_MS}ms. Check camera permission, device id (${GLOBAL_CONFIG.VIDEO.DEVICE}), and ffmpeg availability.`));
        }, GLOBAL_CONFIG.FFMPEG.STARTUP_TIMEOUT_MS);

        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            outputStream.destroy();
            reject(err);
        };

        // ffmpeg 8.1.1 AVFoundation rejects 15fps as an exact capture rate even though
        // the device lists [15..30]fps as the supported range.
        // Capture at 30fps (device max) and let the -vf fps filter downsample to VIDEO.FPS.
        const captureFps = '30';
        ffmpegProcess = spawn(GLOBAL_CONFIG.FFMPEG.BIN, [
            '-hide_banner',
            '-loglevel', 'warning',
            '-f', 'avfoundation',
            '-framerate', captureFps,            // capture at 30fps (device max, always accepted)
            '-video_size', `${width}x${height}`, // lock resolution before capture
            '-i', GLOBAL_CONFIG.VIDEO.DEVICE,    // macOS AVFoundation device
            '-an', '-c:v', 'mjpeg',
            '-q:v', '5',                  // 决定压缩比 (1-31，越小质量越高，2为极高)
            '-pix_fmt', 'yuvj420p',       // 标准 JPEG 采样格式，保证 TensorFlow 兼容性
            '-f', 'image2pipe',
            // 使用高质量缩放算法 (lanczos)，同时降采样到目标 FPS
            '-vf', `fps=${fps},scale=${width}:${height}`,
            'pipe:1',
        ]);

        ffmpegProcess.on('error', (err) => {
            fail(new Error(`Failed to start ffmpeg for camera: ${err.message}. Set FFMPEG_PATH or install ffmpeg.`));
        });

        ffmpegProcess.stderr?.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });

        // 当收到第一帧数据时才 resolve，确保硬件已唤醒
        outputStream.once('data', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            console.log(`📷 Camera stream started via ${GLOBAL_CONFIG.FFMPEG.BIN} device ${GLOBAL_CONFIG.VIDEO.DEVICE}`);
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
            fail(new Error(`Camera ffmpeg exited before producing frames (code=${code}, signal=${signal}).${stderr ? `\n${stderr}` : ''}`));
        });

        ffmpegProcess.stdout?.pipe(outputStream);
    });
}
