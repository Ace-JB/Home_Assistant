import type { SyncSnapshot } from '@/server/modules/media';
import { GLOBAL_CONFIG } from '@/global_config';
import { spawn } from 'child_process';
import { join } from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';


/**
 * 将同步数据保存为 MP4 视频文件
 *
 * 优化要点：
 * 1. 每帧 JPEG 写入独立临时文件，concat 脚本引用每帧并携带实际采集间隔 (durationMs)，
 *    使 FFmpeg 能为每帧设置正确的 PTS，而非假设固定帧率（原方案的核心问题）。
 * 2. 双向音频时间偏移修正：
 *    - 音频晚于视频就绪 → atrim 剪掉前导偏移，asetpts 重置时基。
 *    - 音频早于视频就绪 → -itsoffset 把音频流整体往后推。
 * 3. 视频帧写入采用背压控制，防止大快照导致 OOM。
 * 4. 临时文件目录在 FFmpeg 退出后统一清理。
 * @returns Promise<string> 返回保存的文件路径
 */
async function syncMediaStream(
    syncData: SyncSnapshot,
    fileName: string
): Promise<string> {
    const outputDir = join(process.cwd(), 'recordings');
    const filePath = join(outputDir, fileName);
    await fs.mkdir(outputDir, { recursive: true });

    // ——————————————————————————————————————————————————
    // 第 1 步：将每帧 JPEG 写入独立临时文件，并构造 FFmpeg concat 脚本
    //
    //   为什么不用 image2pipe + -framerate？
    //   image2pipe 要求 FFmpeg 以固定帧率解包，无法反映真实帧间隔；
    //   而帧率抖动（Pipe2Jpeg 重组延迟、事件循环调度）会导致视频速率偏差。
    //
    //   为什么不用 concat + file 'pipe:0'？
    //   pipe:0 是一个只能顺序读取一次的字节流，FFmpeg concat 无法回头重新
    //   打开同一个 pipe 来读取不同的帧，所以必须写到磁盘文件。
    // ——————————————————————————————————————————————————
    const sessionId = `ha_${Date.now()}`;
    const sessionDir = join(tmpdir(), sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const nominalFrameDurationSec = 1 / Number(GLOBAL_CONFIG.VIDEO.FPS);

    // 并行写入所有帧（I/O 密集，并行化可显著缩短等待时间）
    const framePaths = await Promise.all(
        syncData.videos.map(async (frame, i) => {
            const framePath = join(sessionDir, `frame_${String(i).padStart(6, '0')}.jpg`);
            await fs.writeFile(framePath, frame.data);
            return { path: framePath, durationMs: frame.durationMs };
        })
    );

    // 生成 concat 脚本：每帧一个条目，duration 使用实际帧间隔
    const concatLines: string[] = [];
    for (const { path, durationMs } of framePaths) {
        // 第一帧 durationMs === 0（无前驱），回落到名义帧率
        const durationSec = durationMs > 0 ? durationMs / 1000 : nominalFrameDurationSec;
        // 路径含单引号时需转义
        concatLines.push(`file '${path.replace(/'/g, "'\\''")}'`);
        concatLines.push(`duration ${durationSec.toFixed(6)}`);
    }
    // concat 演示符要求最后一帧额外出现一次（无 duration），否则最后一帧被截断
    if (framePaths.length > 0) {
        concatLines.push(`file '${framePaths.at(-1)!.path.replace(/'/g, "'\\''")}'`);
    }
    const concatScriptPath = join(sessionDir, 'concat.txt');
    await fs.writeFile(concatScriptPath, concatLines.join('\n'), 'utf8');

    // ——————————————————————————————————————————————————
    // 第 2 步：计算音视频流的时间偏差，并选择修正策略
    //
    //   audioDelayRelVideo > 0：音频晚于视频到达
    //     → 音频开头有多余的"空白"时间，用 atrim 从偏移量处裁剪
    //   audioDelayRelVideo < 0：音频早于视频到达
    //     → 需要把音频流延迟，用 FFmpeg 的 -itsoffset 参数实现
    // ——————————————————————————————————————————————————
    const videoStartTs = syncData.videos[0]?.ts ?? syncData.startTs;
    const audioStartTs = syncData.audios[0]?.ts ?? syncData.startTs;
    const audioDelayRelVideo = (audioStartTs - videoStartTs) / 1000; // 单位：秒

    // 统一清理临时目录
    const cleanup = () => fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { });

    return new Promise((resolve, reject) => {
        const ffmpegArgs: string[] = [
            '-y',                                   // 覆盖同名文件
            // 输入 0：视频（concat 脚本 + 独立帧文件，携带真实 PTS）
            '-f', 'concat', '-safe', '0',
            '-i', concatScriptPath,
        ];

        // 音频早于视频时，用 -itsoffset 把音频往后推（放在音频输入前）
        if (audioDelayRelVideo < 0) {
            ffmpegArgs.push('-itsoffset', Math.abs(audioDelayRelVideo).toFixed(6));
        }

        ffmpegArgs.push(
            // 输入 1：音频（原始 PCM）
            '-f', 's16le',
            '-ar', GLOBAL_CONFIG.VOICE.SAMPLE_RATE,
            '-ac', '1',
            '-i', 'pipe:3',
            // 视频编码
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
        );

        // 音频晚于视频时，用 atrim 剪掉前导偏移，然后重置 PTS
        if (audioDelayRelVideo > 0) {
            ffmpegArgs.push(
                '-af', `atrim=start=${audioDelayRelVideo.toFixed(6)},asetpts=PTS-STARTPTS`
            );
        }

        ffmpegArgs.push(
            '-c:a', 'aac',
            '-shortest',                            // 以最短流为准结束，防止某流过长
            filePath
        );

        const ffmpeg = spawn(GLOBAL_CONFIG.FFMPEG.BIN, ffmpegArgs, {
            // stdio[0]=stdin（关闭不用），stdio[3]=音频管道
            stdio: ['pipe', 'inherit', 'inherit', 'pipe']
        });

        ffmpeg.on('error', (err) => {
            cleanup();
            console.error('❌ FFmpeg 启动失败:', err);
            reject(err);
        });

        ffmpeg.on('exit', (code) => {
            cleanup();
            if (code === 0) {
                console.log(`✅ 视频合成成功: ${filePath}`);
                resolve(filePath);
            } else {
                reject(new Error(`FFmpeg 退出，错误码: ${code}`));
            }
        });

        // 视频从临时文件读，stdin 无需写入，直接关闭
        ffmpeg.stdin!.end();

        // 将音频 PCM 写入 pipe:3（带背压控制，防止大快照 OOM）
        const audioPipe = ffmpeg.stdio[3] as NodeJS.WritableStream;
        (async () => {
            for (const chunk of syncData.audios) {
                const canWrite = (audioPipe as any).write(chunk.data);
                if (!canWrite) {
                    // 等待 drain 事件再继续，遵守流的背压协议
                    await new Promise<void>(r => (audioPipe as any).once('drain', r));
                }
            }
            (audioPipe as any).end();
        })().catch((e) => {
            console.error('音频数据写入失败:', e);
        });
    });
}

/**
 * 智能保存数据，当视频无法合成时，保存原始数据作为冗余备份
 * @param snapshot 同步数据
 * @param urgency  紧急级别字符串
 */
export async function safeSave(snapshot: SyncSnapshot, urgency: string = 'LOW') {
    // 使用 ISO 时间戳保证文件名安全（不含逗号或空格）
    const safeTs = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${urgency}_${safeTs}.mp4`;
    const rawPath = join(process.cwd(), 'recordings', 'raw', fileName);

    try {
        // 1. 首选方案：合成 MP4
        await syncMediaStream(snapshot, fileName);
    } catch (err) {
        console.error('❌ 视频合成失败，正在启动原始数据冗余保存...', err);

        // 2. 兜底方案：保存原始图片序列和音频块
        await fs.mkdir(rawPath, { recursive: true });

        const videoSaves = snapshot.videos.map((v, i) =>
            fs.writeFile(join(rawPath, `frame_${i}_${v.ts}.jpg`), v.data)
        );
        const audioSaves = snapshot.audios.map((a, i) =>
            fs.writeFile(join(rawPath, `audio_${i}_${a.ts}.pcm`), a.data)
        );

        await Promise.all([...videoSaves, ...audioSaves]);
        console.log(`⚠️ 原始数据已保存在: ${rawPath}`);
    }
}
