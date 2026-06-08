export type AudioSegmentState =
    | 'idle'
    | 'candidate_speech'
    | 'active_speech'
    | 'tail_silence'
    | 'flushing'
    | 'cooldown';

export type AudioSegmentEndReason =
    | 'silence'
    | 'soft_max_duration'
    | 'hard_max_duration'
    | 'system_speaking'
    | 'manual_reset';

export type AudioSegmenterConfig = {
    speechThreshold: number;
    startFrames: number;
    endFrames: number;
    softMaxDurationMs: number;
    hardMaxDurationMs: number;
    cooldownMs?: number;
};

export type AudioFrameLevel = {
    peak: number;
    rms?: number;
};

export type AudioSegment = {
    audio: Buffer;
    segmentStartTs: number;
    segmentEndTs: number;
    lastActiveTs: number;
    endReason: AudioSegmentEndReason;
    forced: boolean;
    frameCount: number;
    activeFrameCount: number;
    peak: number;
    rmsPeak: number;
};

export class AudioSegmenter {
    private state: AudioSegmentState = 'idle';
    private buffers: Buffer[] = [];
    private bufferBytes = 0;
    private segmentStartTs = 0;
    private lastActiveTs = 0;
    private candidateFrames: Array<{ frame: Buffer; level: AudioFrameLevel }> = [];
    private candidateBytes = 0;
    private candidateStartTs = 0;
    private activeStreak = 0;
    private silenceStreak = 0;
    private frameCount = 0;
    private activeFrameCount = 0;
    private peak = 0;
    private rmsPeak = 0;
    private cooldownUntil = 0;

    constructor(private readonly config: AudioSegmenterConfig) {}

    getState(): AudioSegmentState {
        return this.state;
    }

    getBufferedFrameCount(): number {
        return this.buffers.length + this.candidateFrames.length;
    }

    push(frame: Buffer, level: AudioFrameLevel, ts: number): AudioSegment | null {
        if (this.state === 'cooldown' && ts < this.cooldownUntil) {
            return null;
        }
        if (this.state === 'cooldown') {
            this.state = 'idle';
        }

        const speechLike = level.peak >= this.config.speechThreshold;
        if (this.state !== 'idle' && this.segmentStartTs > 0) {
            const totalDuration = ts - this.segmentStartTs;
            if (totalDuration >= this.config.hardMaxDurationMs) {
                this.buffers.push(frame);
                this.bufferBytes += frame.length;
                this.markFrame(level, speechLike);
                return this.flush('hard_max_duration', ts, true);
            }
            if (totalDuration >= this.config.softMaxDurationMs && !speechLike) {
                this.buffers.push(frame);
                this.bufferBytes += frame.length;
                this.markFrame(level, speechLike);
                return this.flush('soft_max_duration', ts, true);
            }
        }

        if (speechLike) {
            return this.pushSpeechFrame(frame, level, ts);
        }
        return this.pushSilenceFrame(frame, level, ts);
    }

    flush(reason: AudioSegmentEndReason, ts: number, forced = reason !== 'silence'): AudioSegment | null {
        if (this.state === 'idle' || this.state === 'cooldown') {
            this.reset(reason, ts);
            return null;
        }

        const allBuffers = this.buffers.length ? this.buffers : this.candidateFrames.map(item => item.frame);
        if (!allBuffers.length) {
            this.reset(reason, ts);
            return null;
        }
        const totalBytes = this.buffers.length ? this.bufferBytes : this.candidateBytes;

        const segment: AudioSegment = {
            audio: Buffer.concat(allBuffers, totalBytes),
            segmentStartTs: this.segmentStartTs || this.candidateStartTs || ts,
            segmentEndTs: ts,
            lastActiveTs: this.lastActiveTs || ts,
            endReason: reason,
            forced,
            frameCount: this.frameCount || allBuffers.length,
            activeFrameCount: this.activeFrameCount,
            peak: this.peak,
            rmsPeak: this.rmsPeak,
        };
        this.reset(reason, ts);
        return segment;
    }

    reset(reason: AudioSegmentEndReason = 'manual_reset', ts = Date.now()): void {
        this.state = this.config.cooldownMs && reason !== 'silence' ? 'cooldown' : 'idle';
        this.cooldownUntil = this.state === 'cooldown' ? ts + (this.config.cooldownMs ?? 0) : 0;
        this.buffers = [];
        this.bufferBytes = 0;
        this.candidateFrames = [];
        this.candidateBytes = 0;
        this.segmentStartTs = 0;
        this.lastActiveTs = 0;
        this.candidateStartTs = 0;
        this.activeStreak = 0;
        this.silenceStreak = 0;
        this.frameCount = 0;
        this.activeFrameCount = 0;
        this.peak = 0;
        this.rmsPeak = 0;
    }

    private pushSpeechFrame(frame: Buffer, level: AudioFrameLevel, ts: number): AudioSegment | null {
        this.activeStreak++;
        this.silenceStreak = 0;
        this.lastActiveTs = ts;

        if (this.state === 'idle') {
            this.state = 'candidate_speech';
            this.candidateStartTs = ts;
            this.candidateFrames = [];
            this.candidateBytes = 0;
        }

        if (this.state === 'candidate_speech') {
            this.candidateFrames.push({ frame, level });
            this.candidateBytes += frame.length;
            if (this.activeStreak >= this.config.startFrames) {
                this.state = 'active_speech';
                this.segmentStartTs = this.candidateStartTs || ts;
                this.buffers = [];
                this.bufferBytes = this.candidateBytes;
                for (const item of this.candidateFrames) {
                    this.buffers.push(item.frame);
                    this.markFrame(item.level, true);
                }
                this.candidateFrames = [];
                this.candidateBytes = 0;
            }
            return null;
        }

        this.state = 'active_speech';
        this.buffers.push(frame);
        this.bufferBytes += frame.length;
        this.markFrame(level, true);
        return null;
    }

    private pushSilenceFrame(frame: Buffer, level: AudioFrameLevel, ts: number): AudioSegment | null {
        this.activeStreak = 0;

        if (this.state === 'candidate_speech') {
            this.reset('manual_reset', ts);
            return null;
        }

        if (this.state === 'active_speech' || this.state === 'tail_silence') {
            this.state = 'tail_silence';
            this.silenceStreak++;
            this.buffers.push(frame);
            this.bufferBytes += frame.length;
            this.markFrame(level, false);
            if (this.silenceStreak >= this.config.endFrames) {
                return this.flush('silence', ts, false);
            }
        }
        return null;
    }

    private markFrame(level: AudioFrameLevel, active: boolean): void {
        this.frameCount++;
        if (active) this.activeFrameCount++;
        this.peak = Math.max(this.peak, level.peak);
        this.rmsPeak = Math.max(this.rmsPeak, level.rms ?? 0);
    }
}
