import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PassThrough } from 'stream';
import type { Readable } from 'stream';
import { GLOBAL_CONFIG } from '@/global_config';
import { funasrService } from '@/server/services/FunASRService';
import { mdxSeparationService } from '@/server/services/voice-assets/MdxSeparationService';
import { getCosyVoiceDataRoot } from '@/server/services/voice-data-paths';
import { pipelineLogs } from '@/server/services/PipelineLogService';
import type { TaskTiming } from '@/server/services/cosyvoice/types';

type ProcessResult = {
    stdout: string;
    stderr: string;
};

export type InterruptibleSpeech = {
    done: Promise<void>;
    stop: () => void;
};

type SpeechOptions = {
    rate?: number;
    voice?: string;
    conversationId?: string;
    logGroupId?: string;
};

type SpeechChunkOptions = {
    minUnits?: number;
    maxUnits?: number;
};

type WavMetadata = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    dataBytes: number;
    durationMs: number;
};

type CosyVoiceAudioRequestResult = {
    audio: Buffer;
    inferenceMs: number;
    readyMs: number;
};

type AsrLogOptions = {
    conversationId?: string | null;
    logGroupId?: string | null;
    utteranceId?: string;
    reason?: string;
    resolveLogGroup?: (text: string) => {
        conversationId?: string | null;
        logGroupId?: string | null;
        utteranceId?: string;
        reason?: string;
    };
};

const ASR_SKIP_LOG_THROTTLE_MS = 5_000;
let lastAsrSkipLogAt = 0;

class CosyVoiceConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CosyVoiceConfigError';
    }
}

let ttsChunkCounter = 0;
let cosyVoicePlaybackTail = Promise.resolve();
let cosyVoiceRequestTail = Promise.resolve();
let cosyVoiceStartTail: Promise<void> | null = null;
const MIN_COSYVOICE_PROMPT_TEXT_CHARS = 6;
const DEFAULT_COSYVOICE_TTS_MIN_UNITS = 28;
const DEFAULT_COSYVOICE_TTS_MAX_UNITS = 60;
const STRONG_BOUNDARY_MIN_UNITS = 8;
const SOFT_BOUNDARY_MIN_RATIO = 0.5;
function getWakeAckCachePaths(): { dir: string; audioPath: string; metaPath: string } {
    const dir = join(getCosyVoiceDataRoot(), 'wake-ack');
    return {
        dir,
        audioPath: join(dir, 'wake-ack.wav'),
        metaPath: join(dir, 'wake-ack.json'),
    };
}

/**
 * 初始化麦克风音频流 (生产者函数)
 */
export async function initAudioListen(): Promise<{ stream: Readable; stop: () => Promise<void> }> {
    const outputStream = new PassThrough();
    let ffmpegProcess: ChildProcess | null = null;

    prewarmFunASRService();

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

function prewarmFunASRService(): void {
    const envPython = resolve(GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_ROOT, 'envs', 'funasr_env', 'bin', 'python');
    if (!existsSync(envPython)) {
        console.warn(`[FunASR] Python service env is missing at ${envPython}. Run: bun run python-services:setup`);
        return;
    }
    void funasrService.start().catch(error => console.error('FunASR prewarm failed:', error));
}

export async function extractTextFromVoiceStream(audio: Buffer, logOptions: AsrLogOptions = {}): Promise<string> {
    if (audio.length === 0) {
        appendAsrDiagnosticLog('ASR skipped', 'debug', 'empty_audio', audio, logOptions);
        return '';
    }
    const audioStats = getSpeechAudioStats(audio);
    if (!audioStats.likelySpeech) {
        appendAsrDiagnosticLog('ASR skipped', 'debug', 'unlikely_speech', audio, logOptions, audioStats);
        return '';
    }

    const sessionDir = await fs.mkdtemp(join(tmpdir(), 'ha-voice-'));
    const wavPath = join(sessionDir, 'audio.wav');

    const startTime = Date.now();
    try {
        const convertStartedAt = Date.now();
        await convertPcmToWav(audio, wavPath);
        const convertMs = Date.now() - convertStartedAt;

        const transcriptionPath = await getAsrTranscriptionPath(wavPath, audio.length);
        // 使用常驻 Service 进行识别
        const transcribeStartedAt = Date.now();
        const transcript = await funasrService.transcribe(transcriptionPath);
        const transcribeMs = Date.now() - transcribeStartedAt;
        const cleaned = normalizeTranscript(transcript);

        const duration = Date.now() - startTime;
        if (!cleaned) {
            appendAsrDiagnosticLog('ASR empty result', 'debug', 'empty_transcript', audio, logOptions, audioStats, {
                durationMs: duration,
                rawTranscript: previewLogText(transcript, 600),
                separated: transcriptionPath !== wavPath,
            });
            return '';
        }

        logOptions.resolveLogGroup?.(cleaned);
        console.log(`[FunASR] Transcription took ${duration}ms (convert=${convertMs}ms, request=${transcribeMs}ms, input=${Math.round(audioStats.durationMs)}ms, reason=${logOptions.reason ?? 'unknown'}): "${cleaned}"`);

        return cleaned;
    } catch (error) {
        console.error(`[FunASR] Error during transcription after ${Date.now() - startTime}ms (input=${Math.round(audioStats.durationMs)}ms, reason=${logOptions.reason ?? 'unknown'}):`, error);
        throw error;
    } finally {
        await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => { });
    }
}

async function getAsrTranscriptionPath(wavPath: string, pcmBytes: number): Promise<string> {
    const mode = GLOBAL_CONFIG.VOICE.ASR_SEPARATION_MODE;
    if (mode === 'off') return wavPath;

    const sampleRate = Number(GLOBAL_CONFIG.VOICE.SAMPLE_RATE);
    const durationMs = sampleRate > 0 ? (pcmBytes / 2 / sampleRate) * 1000 : 0;
    if (durationMs > GLOBAL_CONFIG.VOICE.ASR_SEPARATION_MAX_MS) {
        return wavPath;
    }
    if (mode === 'preprocess') {
        return wavPath;
    }
    if (!mdxSeparationService.isReady()) {
        return wavPath;
    }

    try {
        const result = await mdxSeparationService.separate({
            inputPath: wavPath,
            reason: 'asr-utterance',
            requireService: false,
        });
        return result.fallbackUsed ? wavPath : result.outputPath;
    } catch (error) {
        console.debug('[ASR] Optional MDX separation skipped:', error);
        return wavPath;
    }
}

function getSpeechAudioStats(audio: Buffer): { durationMs: number; peak: number; rms: number; likelySpeech: boolean } {
    const sampleRate = Number(GLOBAL_CONFIG.VOICE.SAMPLE_RATE);
    const durationMs = sampleRate > 0 ? (audio.length / 2 / sampleRate) * 1000 : 0;

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
    return {
        durationMs,
        peak,
        rms,
        likelySpeech: durationMs >= 250 && peak >= 0.02 && rms >= 0.003,
    };
}

function appendAsrDiagnosticLog(
    title: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    reason: string,
    audio: Buffer,
    logOptions: AsrLogOptions,
    stats: { durationMs: number; peak: number; rms: number; likelySpeech: boolean } = getSpeechAudioStats(audio),
    extra: Record<string, unknown> = {},
): void {
    const now = Date.now();
    if (level === 'debug' && now - lastAsrSkipLogAt < ASR_SKIP_LOG_THROTTLE_MS) {
        return;
    }
    if (level === 'debug') {
        lastAsrSkipLogAt = now;
    }
    const metadata = {
        conversationId: logOptions.conversationId ?? null,
        conversation_id: logOptions.conversationId ?? null,
        logGroupId: logOptions.logGroupId ?? null,
        logTs: now,
        utteranceId: logOptions.utteranceId ?? null,
        reason: logOptions.reason ?? null,
        diagnosticReason: reason,
        pcmBytes: audio.length,
        durationMs: Math.round(stats.durationMs),
        peak: Number(stats.peak.toFixed(4)),
        rms: Number(stats.rms.toFixed(5)),
        likelySpeech: stats.likelySpeech,
        ...extra,
    };

    if (GLOBAL_CONFIG.OLLAMA.TRACE_ENABLED) {
        console.debug(`[ASR] ${title}`, metadata);
    } else if (level !== 'debug') {
        console[level](`[ASR] ${title}: ${reason}`, metadata);
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
    const cleaned = transcript
        .split('\n')
        .map((line) => {
            let processed = line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim();
            processed = processed.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '').trim();
            return processed;
        })
        .filter((line) => !/^请用简体中文清晰地回答[。.!！]?$/u.test(line))
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

export function speakInterruptible(text: string, options: SpeechOptions = {}): InterruptibleSpeech {
    if (GLOBAL_CONFIG.VOICE.TTS_PROVIDER === 'cosyvoice') {
        return speakCosyVoiceInterruptible(text, options);
    }
    return speakSayInterruptible(text, options);
}

export function getWakeAckText(): string {
    return cleanSpeechText(GLOBAL_CONFIG.VOICE.WAKE_ACK_TEXT || '我在') || '我在';
}

export function playWakeAckInterruptible(): InterruptibleSpeech {
    if (GLOBAL_CONFIG.VOICE.TTS_PROVIDER === 'cosyvoice') {
        return playCachedWakeAckInterruptible();
    }
    return speakSayInterruptible(getWakeAckText());
}

export async function isWakeAckAudioCached(): Promise<boolean> {
    if (GLOBAL_CONFIG.VOICE.TTS_PROVIDER !== 'cosyvoice') {
        return false;
    }
    return checkWakeAckAudioCache();
}

export async function prewarmWakeAckAudio(): Promise<string | null> {
    if (GLOBAL_CONFIG.VOICE.TTS_PROVIDER !== 'cosyvoice') {
        return null;
    }

    const startedAt = Date.now();
    try {
        const path = await ensureWakeAckAudio(new AbortController().signal);
        pipelineLogs.append({
            category: 'voice-tts',
            level: 'info',
            title: 'wake_ack.prewarm',
            message: 'Wake acknowledgement audio ready.',
            timings: [{ key: 'wake_ack_prewarm', label: '唤醒应答预热', durationMs: Date.now() - startedAt }],
            metadata: {
                provider: 'cosyvoice',
                cached: true,
                path,
                text: getWakeAckText(),
            },
            pipelineId: 'wake-ack',
        });
        return path;
    } catch (error) {
        pipelineLogs.append({
            category: 'voice-tts',
            level: 'warn',
            title: 'wake_ack.prewarm',
            message: getErrorMessage(error),
            timings: [{ key: 'wake_ack_prewarm', label: '唤醒应答预热', durationMs: Date.now() - startedAt, detail: getErrorMessage(error) }],
            metadata: {
                provider: 'cosyvoice',
                cached: false,
                text: getWakeAckText(),
            },
            pipelineId: 'wake-ack',
        });
        throw error;
    }
}

export async function validateTextToSpeechConfig(): Promise<void> {
    if (GLOBAL_CONFIG.VOICE.TTS_PROVIDER !== 'cosyvoice') {
        console.log(`[TTS] provider=say`);
        return;
    }

    const promptAudioPath = GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_AUDIO_PATH.trim();
    const promptText = GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_TEXT.trim();
    const missing: string[] = [];
    if (!promptAudioPath) missing.push('COSYVOICE_PROMPT_AUDIO_PATH');
    if (!promptText) missing.push('COSYVOICE_PROMPT_TEXT');

    if (missing.length > 0) {
        throw new CosyVoiceConfigError(
            `CosyVoice zero-shot is enabled but missing ${missing.join(', ')}. ` +
            `Set both variables, or set SENTINEL_TTS_PROVIDER=say for macOS speech.`,
        );
    }
    if (countNonWhitespaceChars(promptText) < MIN_COSYVOICE_PROMPT_TEXT_CHARS) {
        throw new CosyVoiceConfigError(
            `COSYVOICE_PROMPT_TEXT is too short for MLX zero-shot voice cloning. ` +
            `Use at least ${MIN_COSYVOICE_PROMPT_TEXT_CHARS} spoken characters.`,
        );
    }

    const resolvedPromptAudioPath = resolve(promptAudioPath);
    const promptAudioExists = await fs.stat(resolvedPromptAudioPath)
        .then(stat => stat.isFile())
        .catch(() => false);
    if (!promptAudioExists) {
        throw new CosyVoiceConfigError(
            `COSYVOICE_PROMPT_AUDIO_PATH does not point to a readable file: ${resolvedPromptAudioPath}`,
        );
    }

    console.log(
        `[TTS] provider=cosyvoice url=${new URL(GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT, withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL)).toString()} ` +
        `promptAudio=${resolvedPromptAudioPath} promptTextChars=${promptText.length}`,
    );
}

function speakSayInterruptible(text: string, options: SpeechOptions = {}): InterruptibleSpeech {
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

function speakCosyVoiceInterruptible(text: string, options: SpeechOptions = {}): InterruptibleSpeech {
    const cleanedText = cleanSpeechText(text);
    const chunks = splitCosyVoiceSpeechChunks(cleanedText);
    if (chunks.length > 1) {
        return speakCosyVoiceChunksInterruptible(chunks, options);
    }
    return speakSingleCosyVoiceChunkInterruptible(chunks[0] ?? '', options);
}

function speakCosyVoiceChunksInterruptible(chunks: string[], options: SpeechOptions = {}): InterruptibleSpeech {
    const speeches: InterruptibleSpeech[] = [];
    let stopped = false;
    const done = (async () => {
        for (const chunk of chunks) {
            if (stopped) return;
            const speech = speakSingleCosyVoiceChunkInterruptible(chunk, options);
            speeches.push(speech);
            await speech.done;
        }
    })();

    return {
        done,
        stop: () => {
            stopped = true;
            for (const speech of speeches) {
                speech.stop();
            }
            void cleanupCosyVoiceAfterCancel();
        },
    };
}

function speakSingleCosyVoiceChunkInterruptible(text: string, options: SpeechOptions = {}): InterruptibleSpeech {
    const cleanedText = cleanSpeechText(text);
    const chunkId = ++ttsChunkCounter;
    const logGroupId = options.logGroupId || options.conversationId;
    const controller = new AbortController();
    let player: ChildProcess | null = null;
    let stopped = false;
    let sessionDir = '';
    let playbackTurnReached = false;
    let releasePlaybackTurn: () => void = () => undefined;
    const playbackGate = new Promise<void>(resolve => {
        releasePlaybackTurn = resolve;
    });
    const playbackTurn = cosyVoicePlaybackTail;
    cosyVoicePlaybackTail = cosyVoicePlaybackTail.then(() => playbackGate).catch(() => undefined);

    if (!cleanedText) {
        releasePlaybackTurn();
        return {
            done: Promise.resolve(),
            stop: () => undefined,
        };
    }

    const done = (async () => {
        try {
            const { audio, inferenceMs, readyMs } = await enqueueCosyVoiceAudioRequest(cleanedText, controller.signal, chunkId, {
                conversationId: options.conversationId,
                logGroupId,
            });
            const playableAudio = ensurePlayableWavAudio(audio, cleanedText, chunkId);
            const metadata = readWavMetadata(playableAudio);
            console.log(
                `[TTS:CosyVoice] chunk=${chunkId} inferenceMs=${inferenceMs} readyMs=${readyMs} chars=${cleanedText.length} ` +
                `bytes=${audio.length} wavBytes=${playableAudio.length} sampleRate=${metadata.sampleRate} ` +
                `channels=${metadata.channels} durationMs=${Math.round(metadata.durationMs)} dataBytes=${metadata.dataBytes}`,
            );
            pipelineLogs.append({
                category: 'voice-tts',
                level: 'info',
                title: 'TTS chunk generated',
                message: previewLogText(cleanedText),
                timings: [{ key: 'cosyvoice_request', label: 'CosyVoice 生成', durationMs: inferenceMs }],
                metadata: {
                    chunkId,
                    conversationId: options.conversationId ?? null,
                    conversation_id: options.conversationId ?? null,
                    logGroupId: logGroupId ?? null,
                    chars: cleanedText.length,
                    inferenceMs,
                    readyMs,
                    bytes: audio.length,
                    wavBytes: playableAudio.length,
                    sampleRate: metadata.sampleRate,
                    channels: metadata.channels,
                    bitsPerSample: metadata.bitsPerSample,
                    durationMs: Math.round(metadata.durationMs),
                    dataBytes: metadata.dataBytes,
                    text: cleanedText,
                },
                pipelineId: logGroupId,
            });
            if (stopped) return;

            sessionDir = await fs.mkdtemp(join(tmpdir(), 'ha-cosyvoice-'));
            const audioPath = join(sessionDir, 'speech.wav');
            await fs.writeFile(audioPath, playableAudio);
            await persistLatestCosyVoiceAudio(playableAudio, cleanedText, chunkId, metadata);
            if (stopped) return;

            await playbackTurn;
            playbackTurnReached = true;
            if (stopped) return;

            const playStartedAt = Date.now();
            console.log(`[TTS:CosyVoice] chunk=${chunkId} play_start chars=${cleanedText.length}`);
            await playAudioFile(audioPath, (child) => {
                player = child;
                if (stopped && !child.killed) {
                    child.kill('SIGTERM');
                }
            });
            const playMs = Date.now() - playStartedAt;
            console.log(`[TTS:CosyVoice] chunk=${chunkId} play_done playMs=${playMs}`);
            pipelineLogs.append({
                category: 'voice-tts',
                level: 'info',
                title: 'TTS chunk played',
                message: previewLogText(cleanedText),
                timings: [{ key: 'afplay_playback', label: 'afplay 播放', durationMs: playMs }],
                metadata: {
                    chunkId,
                    conversationId: options.conversationId ?? null,
                    conversation_id: options.conversationId ?? null,
                    logGroupId: logGroupId ?? null,
                    chars: cleanedText.length,
                    audioDurationMs: Math.round(metadata.durationMs),
                    text: cleanedText,
                },
                pipelineId: logGroupId,
            });
        } catch (error) {
            if (stopped || isAbortError(error)) {
                return;
            }
            if (GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY && shouldFallbackToSay(error)) {
                if (!playbackTurnReached) {
                    await playbackTurn;
                    playbackTurnReached = true;
                }
                if (stopped) return;
                console.warn(`[TTS:CosyVoice] chunk=${chunkId} fallback_to_say reason=${getErrorMessage(error)}`);
                pipelineLogs.append({
                    category: 'voice-tts',
                    level: 'warn',
                    title: 'TTS chunk fallback to say',
                    message: getErrorMessage(error),
                    metadata: { chunkId, conversationId: options.conversationId ?? null, conversation_id: options.conversationId ?? null, logGroupId: logGroupId ?? null, chars: cleanedText.length, text: cleanedText },
                    pipelineId: logGroupId,
                });
                await speakSayInterruptible(cleanedText, options).done;
                return;
            }
            console.error(`[TTS:CosyVoice] chunk=${chunkId} failed:`, error);
            pipelineLogs.append({
                category: 'voice-tts',
                level: 'error',
                title: 'TTS chunk failed',
                message: getErrorMessage(error),
                metadata: { chunkId, conversationId: options.conversationId ?? null, conversation_id: options.conversationId ?? null, logGroupId: logGroupId ?? null, chars: cleanedText.length, text: cleanedText },
                pipelineId: logGroupId,
            });
            throw error;
        } finally {
            if (sessionDir) {
                await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
            }
            releasePlaybackTurn();
        }
    })();

    return {
        done,
        stop: () => {
            stopped = true;
            controller.abort();
            if (player && !player.killed) {
                player.kill('SIGTERM');
            }
            void cleanupCosyVoiceAfterCancel();
        },
    };
}

function playCachedWakeAckInterruptible(): InterruptibleSpeech {
    const controller = new AbortController();
    let player: ChildProcess | null = null;
    let fallbackSpeech: InterruptibleSpeech | null = null;
    let stopped = false;
    const done = (async () => {
        const prepareStartedAt = Date.now();
        const [cacheHit, serviceReady] = await Promise.all([
            checkWakeAckAudioCache(),
            isCosyVoiceServiceReady(),
        ]);
        if (!serviceReady || (!cacheHit && GLOBAL_CONFIG.VOICE.WAKE_ACK_FAST_REPLY_ENABLED)) {
            pipelineLogs.append({
                category: 'voice-tts',
                level: serviceReady ? 'warn' : 'info',
                title: 'wake_ack.fallback',
                message: serviceReady
                    ? 'Wake acknowledgement cache miss; using say for immediate feedback.'
                    : 'CosyVoice is not running; using say for wake acknowledgement.',
                timings: [{ key: 'wake_ack_prepare', label: '唤醒应答准备', durationMs: Date.now() - prepareStartedAt }],
                metadata: {
                    provider: 'cosyvoice',
                    fallbackProvider: 'say',
                    cacheHit,
                    serviceReady,
                    fastReplyEnabled: true,
                    cosyVoiceFallbackToSay: GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY,
                    text: getWakeAckText(),
                },
                pipelineId: 'wake-ack',
            });
            void prewarmWakeAckAudio().catch((error) => {
                console.warn('[TTS:CosyVoice] wake ack prewarm failed:', error);
            });
            fallbackSpeech = speakSayInterruptible(getWakeAckText());
            await fallbackSpeech.done;
            return;
        }

        const ackPath = await ensureWakeAckAudio(controller.signal);
        if (stopped) return;
        const prepareMs = Date.now() - prepareStartedAt;
        const playStartedAt = Date.now();
        await playAudioFile(ackPath, (child) => {
            player = child;
            if (stopped && !child.killed) {
                child.kill('SIGTERM');
            }
        });
        pipelineLogs.append({
            category: 'voice-tts',
            level: 'info',
            title: 'wake_ack.played',
            message: 'Wake acknowledgement audio played.',
            timings: [
                { key: 'wake_ack_prepare', label: '唤醒应答准备', durationMs: prepareMs },
                { key: 'afplay_playback', label: 'afplay 播放', durationMs: Date.now() - playStartedAt },
            ],
            metadata: {
                provider: 'cosyvoice',
                cacheHit,
                serviceReady,
                fastReplyEnabled: GLOBAL_CONFIG.VOICE.WAKE_ACK_FAST_REPLY_ENABLED,
                path: ackPath,
                text: getWakeAckText(),
            },
            pipelineId: 'wake-ack',
        });
    })();

    return {
        done,
        stop: () => {
            stopped = true;
            controller.abort();
            fallbackSpeech?.stop();
            if (player && !player.killed) {
                player.kill('SIGTERM');
            }
        },
    };
}

async function isCosyVoiceServiceReady(): Promise<boolean> {
    if (GLOBAL_CONFIG.VOICE.TTS_PROVIDER !== 'cosyvoice') {
        return false;
    }
    const healthUrl = new URL('/health', withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL));
    return fetch(healthUrl, { signal: AbortSignal.timeout(700) })
        .then(async response => {
            if (!response.ok) return false;
            const payload = await response.json().catch(() => null) as { ready?: boolean; ok?: boolean } | null;
            return Boolean(payload?.ready ?? payload?.ok);
        })
        .catch(() => false);
}

async function checkWakeAckAudioCache(): Promise<boolean> {
    const paths = getWakeAckCachePaths();
    const cacheKey = getWakeAckCacheKey();
    const existingMeta = await fs.readFile(paths.metaPath, 'utf8')
        .then(content => JSON.parse(content) as { cacheKey?: string })
        .catch(() => null);
    return existingMeta?.cacheKey === cacheKey
        && await fs.stat(paths.audioPath).then(stat => stat.isFile()).catch(() => false);
}

function getWakeAckCacheKey(): string {
    const text = getWakeAckText();
    const promptAudioPath = GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_AUDIO_PATH.trim();
    const speakerId = GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_ID.trim();
    return JSON.stringify({
        text,
        speakerId,
        promptAudioPath: promptAudioPath ? resolve(promptAudioPath) : '',
        promptText: GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_TEXT.trim(),
        sampleRate: GLOBAL_CONFIG.VOICE.COSYVOICE_SAMPLE_RATE,
    });
}

async function ensureWakeAckAudio(signal: AbortSignal): Promise<string> {
    const paths = getWakeAckCachePaths();
    const text = getWakeAckText();
    const promptAudioPath = GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_AUDIO_PATH.trim();
    const speakerId = GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_ID.trim();
    const cacheKey = getWakeAckCacheKey();
    if (await checkWakeAckAudioCache()) {
        return paths.audioPath;
    }

    await fs.mkdir(paths.dir, { recursive: true });
    const chunkId = ++ttsChunkCounter;
    const { audio } = await requestCosyVoiceAudio(text, signal, chunkId);
    const playableAudio = ensurePlayableWavAudio(audio, text, chunkId);
    const metadata = readWavMetadata(playableAudio);
    await fs.writeFile(paths.audioPath, playableAudio);
    await fs.writeFile(paths.metaPath, `${JSON.stringify({
        cacheKey,
        text,
        speakerId,
        promptAudioPath,
        createdAt: new Date().toISOString(),
        durationMs: Math.round(metadata.durationMs),
        sampleRate: metadata.sampleRate,
    }, null, 2)}\n`, 'utf8');
    console.log(`[TTS:CosyVoice] wake_ack_cached path=${paths.audioPath} text="${text}"`);
    return paths.audioPath;
}

async function requestCosyVoiceAudio(text: string, signal: AbortSignal, chunkId: number): Promise<CosyVoiceAudioRequestResult> {
    const promptAudioPath = GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_AUDIO_PATH.trim();
    const promptText = GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_TEXT.trim();
    if (!promptAudioPath || !promptText) {
        throw new CosyVoiceConfigError('CosyVoice zero-shot requires COSYVOICE_PROMPT_AUDIO_PATH and COSYVOICE_PROMPT_TEXT.');
    }
    if (countNonWhitespaceChars(promptText) < MIN_COSYVOICE_PROMPT_TEXT_CHARS) {
        throw new CosyVoiceConfigError(
            `COSYVOICE_PROMPT_TEXT is too short for MLX zero-shot voice cloning. ` +
            `Use at least ${MIN_COSYVOICE_PROMPT_TEXT_CHARS} spoken characters.`,
        );
    }

    const timeoutMs = GLOBAL_CONFIG.VOICE.COSYVOICE_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeout]);
    const form = new FormData();
    const speakerId = GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_ID.trim();

    form.set('tts_text', text);
    form.set('prompt_text', promptText);
    if (speakerId) {
        form.set('zero_shot_spk_id', speakerId);
    } else {
        form.set('prompt_wav', Bun.file(resolve(promptAudioPath)));
    }

    const readyStartedAt = Date.now();
    await ensureCosyVoiceReady(combinedSignal);
    const readyMs = Date.now() - readyStartedAt;
    const url = new URL(GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT, withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL));
    console.log(`[TTS:CosyVoice] chunk=${chunkId} request chars=${text.length} speaker=${speakerId || 'inline-zero-shot'} url=${url.toString()}`);
    const inferenceStartedAt = Date.now();
    const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: combinedSignal,
    }).catch((error) => {
        throw new CosyVoiceServiceError(
            `CosyVoice service is unreachable at ${url.toString()}. ` +
            `Start the CosyVoice FastAPI service or update COSYVOICE_BASE_URL.`,
            error,
        );
    });
    const responseBytes = Buffer.from(await response.arrayBuffer());
    const inferenceMs = Date.now() - inferenceStartedAt;

    if (!response.ok) {
        const detail = responseBytes.toString('utf8').slice(0, 300);
        throw new Error(`CosyVoice request failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
    }

    return { audio: responseBytes, inferenceMs, readyMs };
}

async function ensureCosyVoiceReady(signal: AbortSignal): Promise<void> {
    const baseUrl = withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL);
    const healthUrl = new URL('/health', baseUrl);
    const startUrl = new URL('/start', baseUrl);
    const health = await fetch(healthUrl, { signal })
        .then(response => response.ok ? response.json() as Promise<{ ready?: boolean }> : null)
        .catch(() => null);
    if (health?.ready) return;

    if (!cosyVoiceStartTail) {
        const startedAt = Date.now();
        cosyVoiceStartTail = fetch(startUrl, { method: 'POST', signal })
            .then(async response => {
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    throw new CosyVoiceServiceError(
                        `CosyVoice service failed to start at ${startUrl.toString()}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
                    );
                }
                console.info(`[TTS:CosyVoice] lazy_start ready ms=${Date.now() - startedAt}`);
            })
            .catch((error) => {
                console.warn(`[TTS:CosyVoice] lazy_start failed ms=${Date.now() - startedAt}: ${getErrorMessage(error)}`);
                if (error instanceof CosyVoiceServiceError) {
                    throw error;
                }
                throw new CosyVoiceServiceError(
                    `CosyVoice service is unreachable at ${startUrl.toString()}. ` +
                    `Start the CosyVoice FastAPI service or set SENTINEL_TTS_PROVIDER=say.`,
                    error,
                );
            })
            .finally(() => {
                cosyVoiceStartTail = null;
            });
    }

    await cosyVoiceStartTail;
}

async function cleanupCosyVoiceAfterCancel(): Promise<void> {
    if (
        GLOBAL_CONFIG.VOICE.TTS_PROVIDER !== 'cosyvoice'
        || !GLOBAL_CONFIG.VOICE.COSYVOICE_TTS_CLEANUP_ON_CANCEL
    ) {
        return;
    }

    const cleanupUrl = new URL('/cleanup', withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL));
    await fetch(cleanupUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(1000),
    }).catch((error) => {
        console.debug(`[TTS:CosyVoice] cleanup skipped: ${getErrorMessage(error)}`);
    });
}

function enqueueCosyVoiceAudioRequest(
    text: string,
    signal: AbortSignal,
    chunkId: number,
    logOptions: { conversationId?: string; logGroupId?: string } = {},
): Promise<CosyVoiceAudioRequestResult> {
    const enqueuedAt = Date.now();
    const requestTurn = cosyVoiceRequestTail;
    let releaseRequestTurn: () => void = () => undefined;
    cosyVoiceRequestTail = new Promise<void>(resolve => {
        releaseRequestTurn = resolve;
    });

    return (async () => {
        await requestTurn.catch(() => undefined);
        const startedAt = Date.now();
        const waitMs = startedAt - enqueuedAt;
        console.log(`[TTS:CosyVoice] chunk=${chunkId} request_queue_enter chars=${text.length} waitMs=${waitMs}`);
        try {
            if (signal.aborted) {
                throw new DOMException('CosyVoice request aborted before queue turn.', 'AbortError');
            }
            return await requestCosyVoiceAudio(text, signal, chunkId);
        } finally {
            const runMs = Date.now() - startedAt;
            console.log(`[TTS:CosyVoice] chunk=${chunkId} request_queue_leave runMs=${runMs}`);
            if (logOptions.logGroupId) {
                pipelineLogs.append({
                    category: 'voice-tts',
                    level: signal.aborted ? 'debug' : 'info',
                    title: 'TTS request queue turn',
                    message: previewLogText(text),
                    timings: [
                        { key: 'queue_wait', label: '请求排队等待', durationMs: waitMs },
                        { key: 'queue_run', label: '请求队列执行', durationMs: runMs },
                    ],
                    metadata: {
                        chunkId,
                        conversationId: logOptions.conversationId ?? null,
                        conversation_id: logOptions.conversationId ?? null,
                        logGroupId: logOptions.logGroupId,
                        chars: text.length,
                        aborted: signal.aborted,
                        text,
                    },
                    pipelineId: logOptions.logGroupId,
                });
            }
            releaseRequestTurn();
        }
    })();
}

function ensurePlayableWavAudio(audio: Buffer, text: string, chunkId: number): Buffer {
    const playableAudio = ensureWavAudio(audio, GLOBAL_CONFIG.VOICE.COSYVOICE_SAMPLE_RATE);
    const metadata = readWavMetadata(playableAudio);
    const minDurationMs = getMinimumCosyVoiceDurationMs(text);

    if (metadata.dataBytes <= 0) {
        throw new Error(`CosyVoice returned empty wav audio for chunk=${chunkId}.`);
    }
    if (metadata.durationMs < minDurationMs) {
        throw new Error(
            `CosyVoice returned too-short wav audio for chunk=${chunkId}: ` +
            `durationMs=${Math.round(metadata.durationMs)} minDurationMs=${minDurationMs} chars=${text.length}.`,
        );
    }
    return playableAudio;
}

function ensureWavAudio(audio: Buffer, sampleRate: number): Buffer {
    if (audio.length >= 12 && audio.subarray(0, 4).toString('ascii') === 'RIFF' && audio.subarray(8, 12).toString('ascii') === 'WAVE') {
        return audio;
    }
    if (audio.length === 0) {
        throw new Error('CosyVoice returned empty audio bytes.');
    }

    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + audio.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(audio.length, 40);
    return Buffer.concat([header, audio]);
}

function readWavMetadata(audio: Buffer): WavMetadata {
    if (audio.length < 44 || audio.subarray(0, 4).toString('ascii') !== 'RIFF' || audio.subarray(8, 12).toString('ascii') !== 'WAVE') {
        throw new Error('CosyVoice response is not a valid wav file.');
    }

    const fmtOffset = findWavChunk(audio, 'fmt ');
    const dataOffset = findWavChunk(audio, 'data');
    if (fmtOffset < 0 || dataOffset < 0) {
        throw new Error('CosyVoice wav is missing fmt or data chunk.');
    }

    const fmtSize = audio.readUInt32LE(fmtOffset + 4);
    if (fmtSize < 16 || fmtOffset + 8 + fmtSize > audio.length) {
        throw new Error('CosyVoice wav has an invalid fmt chunk.');
    }

    const channels = audio.readUInt16LE(fmtOffset + 10);
    const sampleRate = audio.readUInt32LE(fmtOffset + 12);
    const bitsPerSample = audio.readUInt16LE(fmtOffset + 22);
    const dataBytes = audio.readUInt32LE(dataOffset + 4);
    if (dataOffset + 8 + dataBytes > audio.length) {
        throw new Error('CosyVoice wav has an invalid data chunk.');
    }
    const bytesPerSecond = sampleRate * channels * bitsPerSample / 8;
    if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0 || bytesPerSecond <= 0) {
        throw new Error('CosyVoice wav has invalid audio format metadata.');
    }

    return {
        sampleRate,
        channels,
        bitsPerSample,
        dataBytes,
        durationMs: dataBytes / bytesPerSecond * 1000,
    };
}

function findWavChunk(audio: Buffer, chunkId: string): number {
    let offset = 12;
    while (offset + 8 <= audio.length) {
        const id = audio.subarray(offset, offset + 4).toString('ascii');
        const size = audio.readUInt32LE(offset + 4);
        if (id === chunkId) {
            return offset;
        }
        offset += 8 + size + (size % 2);
    }
    return -1;
}

function getMinimumCosyVoiceDurationMs(text: string): number {
    const cjkChars = Array.from(text.matchAll(/\p{Script=Han}/gu)).length;
    const nonSpaceChars = Array.from(text.replace(/\s+/g, '')).length;
    const expectedFromChars = Math.max(cjkChars, nonSpaceChars * 0.45) * 70;
    return Math.min(900, Math.max(220, Math.floor(expectedFromChars)));
}

function playAudioFile(audioPath: string, onChild: (child: ChildProcess) => void): Promise<void> {
    return new Promise((resolvePlay, reject) => {
        const child = spawn('afplay', [audioPath], { stdio: 'ignore' });
        onChild(child);

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal === 'SIGTERM' || code === 0) {
                resolvePlay();
                return;
            }
            reject(new Error(`afplay exited with code=${code}, signal=${signal}`));
        });
    });
}

function withTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isCosyVoiceConfigError(error: unknown): boolean {
    return error instanceof Error && error.name === 'CosyVoiceConfigError';
}

class CosyVoiceServiceError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, { cause });
        this.name = 'CosyVoiceServiceError';
    }
}

export function shouldFallbackToSay(error: unknown): boolean {
    return error instanceof Error
        && error.name === 'CosyVoiceServiceError';
}

export function createCosyVoiceServiceErrorForTest(message: string): Error {
    return new CosyVoiceServiceError(message);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function previewLogText(text: string, limit = 80): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

export function extractSpeechReadyChunk(text: string, minChars = 20): { chunk: string; rest: string } | null {
    const normalized = normalizeSpeechChunkText(text);
    const minUnits = Math.max(1, minChars);
    const maxUnits = getCosyVoiceMaxSpeechUnits();
    const chunkEnd = findCosyVoiceChunkEnd(normalized, {
        minUnits,
        maxUnits: Math.max(maxUnits, minUnits),
        allowShortFinal: false,
    });
    if (chunkEnd < 0) return null;

    const chunk = normalized.slice(0, chunkEnd).trim();
    const rest = normalized.slice(chunkEnd);
    return chunk ? { chunk, rest } : null;
}

export function splitCosyVoiceSpeechChunks(text: string, options: SpeechChunkOptions = {}): string[] {
    let rest = normalizeSpeechChunkText(text);
    const chunks: string[] = [];
    const minUnits = options.minUnits ?? getCosyVoiceMinSpeechUnits();
    const maxUnits = options.maxUnits ?? getCosyVoiceMaxSpeechUnits();

    while (rest.trim()) {
        const end = findCosyVoiceChunkEnd(rest, { minUnits, maxUnits, allowShortFinal: true });
        const safeEnd = end > 0 ? end : rest.length;
        const chunk = rest.slice(0, safeEnd).trim();
        rest = rest.slice(safeEnd);
        if (chunk) chunks.push(chunk);
    }

    return mergeShortSpeechTails(chunks, minUnits, maxUnits);
}

export function estimateSpeechUnits(text: string): number {
    const normalized = normalizeSpeechChunkText(text);
    const cjkChars = Array.from(normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)).length;
    const urlMatches = normalized.match(/https?:\/\/\S+|www\.\S+/giu) ?? [];
    const versionMatches = normalized.match(/\bv?\d+(?:\.\d+){1,}\b/giu) ?? [];
    const protectedText = normalized
        .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
        .replace(/\bv?\d+(?:\.\d+){1,}\b/giu, ' ')
        .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ');
    const words = protectedText.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const punctuation = protectedText.match(/[。！？!?；;，,、：:]/gu) ?? [];

    return cjkChars
        + words.reduce((sum, word) => sum + Math.max(1, Math.ceil(word.length / 6)), 0)
        + urlMatches.reduce((sum, url) => sum + Math.max(4, Math.ceil(url.length / 12)), 0)
        + versionMatches.length
        + Math.ceil(punctuation.length * 0.35);
}

function findCosyVoiceChunkEnd(
    text: string,
    options: { minUnits: number; maxUnits: number; allowShortFinal: boolean },
): number {
    const trimmed = text.trim();
    if (!trimmed) return -1;
    if (options.allowShortFinal && estimateSpeechUnits(trimmed) <= options.maxUnits) {
        return text.length;
    }

    const boundaries = collectSpeechBoundaries(text);
    const boundary = chooseElasticBoundary(text, boundaries, options.minUnits, options.maxUnits);
    if (boundary > 0) return boundary;

    if (estimateSpeechUnits(trimmed) < options.maxUnits) {
        return -1;
    }

    return findForcedSpeechBoundary(text, options.maxUnits);
}

function chooseElasticBoundary(
    text: string,
    boundaries: Array<{ end: number; type: 'strong' | 'soft' }>,
    minUnits: number,
    maxUnits: number,
): number {
    const strongMinUnits = Math.min(STRONG_BOUNDARY_MIN_UNITS, minUnits);
    const softMinUnits = Math.max(1, Math.floor(minUnits * SOFT_BOUNDARY_MIN_RATIO));

    for (const boundary of boundaries) {
        const units = estimateSpeechUnits(text.slice(0, boundary.end));
        if (units > maxUnits) {
            return -1;
        }
        if (boundary.type === 'strong' && units >= strongMinUnits) return boundary.end;
        if (boundary.type === 'soft' && units >= softMinUnits) return boundary.end;
    }
    return -1;
}

function collectSpeechBoundaries(text: string): Array<{ end: number; type: 'strong' | 'soft' }> {
    const boundaries: Array<{ end: number; type: 'strong' | 'soft' }> = [];
    const strongPattern = /(?:……|\.{3}|[。！？!?；;\n]+)/gu;
    const softPattern = /[，,、：:]/gu;
    for (const match of text.matchAll(strongPattern)) {
        const end = match.index + match[0].length;
        if (isSafeForcedBoundary(text, end)) {
            boundaries.push({ end, type: 'strong' });
        }
    }
    for (const match of text.matchAll(softPattern)) {
        const end = match.index + match[0].length;
        if (isSafeForcedBoundary(text, end)) {
            boundaries.push({ end, type: 'soft' });
        }
    }
    return boundaries.sort((a, b) => a.end - b.end);
}

function findForcedSpeechBoundary(text: string, maxUnits: number): number {
    let best = -1;
    for (let end = 1; end <= text.length; end++) {
        const nextEnd = nextCodePointEnd(text, end - 1);
        if (nextEnd !== end) continue;
        if (!isSafeForcedBoundary(text, end)) continue;
        const units = estimateSpeechUnits(text.slice(0, end));
        if (units <= maxUnits) {
            best = end;
            continue;
        }
        break;
    }
    if (best > 0) return best;

    for (let end = 1; end <= text.length; end++) {
        const nextEnd = nextCodePointEnd(text, end - 1);
        if (nextEnd !== end) continue;
        if (isCjkChar(text.slice(end - 1, end))) return end;
    }
    return text.length;
}

function isSafeForcedBoundary(text: string, end: number): boolean {
    if (end <= 0 || end >= text.length) return end > 0;
    const left = text.slice(0, end);
    const right = text.slice(end);
    if (/\s$/u.test(left) || /^\s/u.test(right)) return true;
    const leftChar = Array.from(left).at(-1) ?? '';
    const rightChar = Array.from(right)[0] ?? '';
    if (isCjkChar(leftChar) && isCjkChar(rightChar)) return true;
    if (isAsciiTokenChar(leftChar) && isAsciiTokenChar(rightChar)) return false;
    if (/[。！？!?；;，,、：:\n]$/u.test(left)) return true;
    return !isAsciiTokenChar(leftChar) && !isAsciiTokenChar(rightChar);
}

function mergeShortSpeechTails(chunks: string[], minUnits: number, maxUnits: number): string[] {
    const merged: string[] = [];
    for (const chunk of chunks) {
        const previous = merged[merged.length - 1];
        if (previous && estimateSpeechUnits(chunk) < minUnits && estimateSpeechUnits(`${previous}${chunk}`) <= Math.max(maxUnits, minUnits * 2)) {
            merged[merged.length - 1] = `${previous}${needsSpeechJoinSpace(previous, chunk) ? ' ' : ''}${chunk}`;
        } else {
            merged.push(chunk);
        }
    }
    return merged;
}

function needsSpeechJoinSpace(left: string, right: string): boolean {
    const leftChar = Array.from(left).at(-1) ?? '';
    const rightChar = Array.from(right)[0] ?? '';
    return isAsciiTokenChar(leftChar) && isAsciiTokenChar(rightChar);
}

function getCosyVoiceMinSpeechUnits(): number {
    return Math.max(1, GLOBAL_CONFIG.VOICE.COSYVOICE_TTS_MIN_UNITS || DEFAULT_COSYVOICE_TTS_MIN_UNITS);
}

function getCosyVoiceMaxSpeechUnits(): number {
    const minUnits = getCosyVoiceMinSpeechUnits();
    return Math.max(minUnits, GLOBAL_CONFIG.VOICE.COSYVOICE_TTS_MAX_UNITS || DEFAULT_COSYVOICE_TTS_MAX_UNITS);
}

function normalizeSpeechChunkText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n+ */g, '\n')
        .trimStart();
}

function nextCodePointEnd(text: string, index: number): number {
    const code = text.charCodeAt(index);
    return code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length ? index + 2 : index + 1;
}

function isCjkChar(value: string): boolean {
    return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(value);
}

function isAsciiTokenChar(value: string): boolean {
    return /^[A-Za-z0-9_./:?#&=%+-]$/u.test(value);
}

async function persistLatestCosyVoiceAudio(audio: Buffer, text: string, chunkId: number, metadata: WavMetadata): Promise<void> {
    const cacheDir = resolve('src/server/temp_cache');
    const wavPath = join(cacheDir, 'cosyvoice-latest.wav');
    const metaPath = join(cacheDir, 'cosyvoice-latest.txt');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(wavPath, audio);
    await fs.writeFile(metaPath, [
        `chunkId=${chunkId}`,
        `createdAt=${new Date().toISOString()}`,
        `chars=${text.length}`,
        `sampleRate=${metadata.sampleRate}`,
        `channels=${metadata.channels}`,
        `bitsPerSample=${metadata.bitsPerSample}`,
        `durationMs=${Math.round(metadata.durationMs)}`,
        `dataBytes=${metadata.dataBytes}`,
        `text=${text}`,
        '',
    ].join('\n'), 'utf8');
    console.log(`[TTS:CosyVoice] chunk=${chunkId} latest_saved wav=${wavPath} meta=${metaPath} chars=${text.length}`);
}

function findFallbackBoundary(text: string, minChars: number): number {
    const target = Math.max(minChars, Math.min(text.length, 32));
    const tail = text.slice(target);
    const whitespace = tail.search(/\s/u);
    return whitespace >= 0 ? target + whitespace + 1 : target;
}

export async function speak(text: string, options: SpeechOptions = {}): Promise<void> {
    return speakInterruptible(text, options).done;
}

function cleanSpeechText(text: string): string {
    return text
        .replace(/\([^)]*\)/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function countNonWhitespaceChars(value: string): number {
    return Array.from(value.replace(/\s+/g, '')).length;
}
