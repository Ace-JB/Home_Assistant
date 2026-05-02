// src/modules/camera-stream.ts
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import { GLOBAL_CONFIG } from '@/global_config';

export class CameraStream extends Readable {
    private ffmpegProcess: ChildProcess | null = null;

    constructor(
        private width: number = GLOBAL_CONFIG.VIDEO.WIDTH,
        private height: number = GLOBAL_CONFIG.VIDEO.HEIGHT
    ) {
        super();
    }

    override _read(size: number) { }

    /**
     * 启动硬件摄像头采集 (AVFoundation + MJPEG)
     */
    start() {
        console.log(`📹 正在启动本地摄像头 (AVFoundation)...`);
        this.ffmpegProcess = spawn('ffmpeg', [
            '-loglevel', 'quiet',
            // *** input ***
            // '-re', // optional process video in real-time not as fast as possible
            // '-i', `${inputFile}`, // input file
            // *** output ***
            '-an', // drop audio
            '-c:v', 'mjpeg', // use motion jpeg as output encoder
            '-pix_fmt', 'yuvj422p', // typical for mp4, may need different settings for some videos
            '-f', 'image2pipe', // pipe images as output
            '-vf', 'fps=5,scale=800:600', // optional video filter, do anything here such as process at fixed 5fps or resize to specific resulution
            'pipe:1', // output to unix pipe that is then captured by pipe2jpeg
        ]);

        this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
            this.push(chunk);
        });

        this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
            const log = data.toString();
            if (log.toLowerCase().includes('error')) console.warn(`[FFmpeg Err]: ${log}`);
        });

        this.ffmpegProcess.on('exit', (code: number) => {
            console.log(`📹 摄像头采集进程已停止 (Exit Code: ${code})`);
            this.push(null);
            this.ffmpegProcess = null;
        });
    }

    stop() {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
            console.log('🛑 正在清理 FFmpeg 摄像头资源...');
            this.ffmpegProcess.kill('SIGKILL');
            this.ffmpegProcess = null;
        }
    }
}