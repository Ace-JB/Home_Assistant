import { GLOBAL_CONFIG } from "@/global_config";

// 统一的感知帧格式
export interface PerceptualFrame<T = Buffer> {
    ts: number;         // 系统时间戳 Date.now() (ms)
    durationMs: number; // 此帧相对上一帧的实际间隔 (ms)，用于正确设置 PTS
    data: T;            // 原始 Buffer (JPEG 或 PCM)
    meta?: unknown;     // 识别结果 (例如 FaceEngine 的 label)
}

export interface SyncSnapshot {
    videos: PerceptualFrame[];
    audios: PerceptualFrame[];
    /** 快照的实际开始时间戳 (ms)，用于音频精确对齐 */
    startTs: number;
    /** 快照的实际结束时间戳 (ms) */
    endTs: number;
}

export class SyncManager {
    private videoRing: PerceptualFrame[] = [];
    private audioRing: PerceptualFrame[] = [];
    private readonly windowSizeMs: number;
    private lastVideoTs: number = 0;
    private lastAudioTs: number = 0;

    constructor(windowSizeMs: number = 30_000) {
        this.windowSizeMs = windowSizeMs;
    }

    // 存入视频帧 — 记录与上一帧的实际时间间隔
    addVideo(buffer: Buffer, meta?: unknown) {
        const now = Date.now();
        const durationMs = this.lastVideoTs === 0 ? 0 : now - this.lastVideoTs;
        this.lastVideoTs = now;
        const frame: PerceptualFrame = { ts: now, durationMs, data: buffer, meta };
        this.videoRing.push(frame);
        this.cleanOld(this.videoRing);
    }

    // 存入音频块 — 记录与上一块的实际时间间隔
    addAudio(buffer: Buffer) {
        const now = Date.now();
        const durationMs = this.lastAudioTs === 0 ? 0 : now - this.lastAudioTs;
        this.lastAudioTs = now;
        const frame: PerceptualFrame = { ts: now, durationMs, data: buffer };
        this.audioRing.push(frame);
        this.cleanOld(this.audioRing);
    }

    // 清理过期数据
    private cleanOld(ring: PerceptualFrame[]) {
        const now = Date.now();
        while (ring.length > 0 && now - ring[0]!.ts > this.windowSizeMs) {
            ring.shift();
        }
    }

    /**
     * 获取同步的片段
     * @param duration 想要回溯的时长（毫秒）
     *
     * 返回的帧包含 durationMs，表示相对上一帧的实际采集间隔，
     * 消费者应使用它构造正确的 PTS，而不是假设固定帧率。
     * startTs / endTs 用于在合成时精确对齐音频偏移量。
     */
    getSnapshot(duration: number): SyncSnapshot {
        const now = Date.now();
        const startTime = now - duration;

        const videos = this.videoRing.filter(f => f.ts >= startTime);
        const audios = this.audioRing.filter(f => f.ts >= startTime);

        // 以最早有数据的流作为快照起始时间
        const videoStart = videos[0]?.ts ?? now;
        const audioStart = audios[0]?.ts ?? now;
        const startTs = Math.min(videoStart, audioStart);

        return { videos, audios, startTs, endTs: now };
    }
}

export const syncManager = new SyncManager(GLOBAL_CONFIG.SYNC.WINDOW_SIZE);
