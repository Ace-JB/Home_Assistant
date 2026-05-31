import { spawn, exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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

type SpeechOptions = {
    rate?: number;
    voice?: string;
};

type WavMetadata = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    dataBytes: number;
    durationMs: number;
};

class CosyVoiceConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CosyVoiceConfigError';
    }
}

let ttsChunkCounter = 0;
let cosyVoicePlaybackTail = Promise.resolve();
let cosyVoiceRequestTail = Promise.resolve();
const MIN_COSYVOICE_PROMPT_TEXT_CHARS = 6;

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
    const chunkId = ++ttsChunkCounter;
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
        const startedAt = Date.now();
        try {
            const audio = await enqueueCosyVoiceAudioRequest(cleanedText, controller.signal, chunkId);
            const playableAudio = ensurePlayableWavAudio(audio, cleanedText, chunkId);
            const metadata = readWavMetadata(playableAudio);
            console.log(
                `[TTS:CosyVoice] chunk=${chunkId} requestMs=${Date.now() - startedAt} chars=${cleanedText.length} ` +
                `bytes=${audio.length} wavBytes=${playableAudio.length} sampleRate=${metadata.sampleRate} ` +
                `channels=${metadata.channels} durationMs=${Math.round(metadata.durationMs)} dataBytes=${metadata.dataBytes}`,
            );
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
            console.log(`[TTS:CosyVoice] chunk=${chunkId} play_done playMs=${Date.now() - playStartedAt}`);
        } catch (error) {
            if (stopped || isAbortError(error)) {
                return;
            }
            console.error(`[TTS:CosyVoice] chunk=${chunkId} failed:`, error);
            if (GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY && shouldFallbackToSay(error)) {
                if (!playbackTurnReached) {
                    await playbackTurn;
                    playbackTurnReached = true;
                }
                if (stopped) return;
                console.warn(`[TTS:CosyVoice] chunk=${chunkId} fallback_to_say reason=${getErrorMessage(error)}`);
                await speakSayInterruptible(cleanedText, options).done;
                return;
            }
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
        },
    };
}

async function requestCosyVoiceAudio(text: string, signal: AbortSignal, chunkId: number): Promise<Buffer> {
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

    const url = new URL(GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT, withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL));
    console.log(`[TTS:CosyVoice] chunk=${chunkId} request chars=${text.length} speaker=${speakerId || 'inline-zero-shot'} url=${url.toString()}`);
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

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`CosyVoice request failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

function enqueueCosyVoiceAudioRequest(text: string, signal: AbortSignal, chunkId: number): Promise<Buffer> {
    const enqueuedAt = Date.now();
    const requestTurn = cosyVoiceRequestTail;
    let releaseRequestTurn: () => void = () => undefined;
    cosyVoiceRequestTail = new Promise<void>(resolve => {
        releaseRequestTurn = resolve;
    });

    return (async () => {
        await requestTurn.catch(() => undefined);
        const startedAt = Date.now();
        console.log(`[TTS:CosyVoice] chunk=${chunkId} request_queue_enter chars=${text.length} waitMs=${startedAt - enqueuedAt}`);
        try {
            if (signal.aborted) {
                throw new DOMException('CosyVoice request aborted before queue turn.', 'AbortError');
            }
            return await requestCosyVoiceAudio(text, signal, chunkId);
        } finally {
            console.log(`[TTS:CosyVoice] chunk=${chunkId} request_queue_leave runMs=${Date.now() - startedAt}`);
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

function shouldFallbackToSay(error: unknown): boolean {
    return error instanceof Error
        && error.name !== 'CosyVoiceConfigError';
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function extractSpeechReadyChunk(text: string, minChars = 20): { chunk: string; rest: string } | null {
    const normalized = text.replace(/\s+/g, ' ');
    const boundary = findSpeechBoundary(normalized, minChars);
    if (boundary.index >= 0) {
        const { index } = boundary;
        const chunk = normalized.slice(0, index + 1).trim();
        const rest = normalized.slice(index + 1);
        return chunk ? { chunk, rest } : null;
    }

    if (normalized.trim().length >= minChars) {
        const fallbackBoundary = findFallbackBoundary(normalized, minChars);
        const chunk = normalized.slice(0, fallbackBoundary).trim();
        const rest = normalized.slice(fallbackBoundary);
        return chunk ? { chunk, rest } : null;
    }

    return null;
}

function findSpeechBoundary(text: string, minChars: number): { index: number; type: 'strong' | 'soft' | null } {
    const soft = text.search(/[，,、：:]/u);
    if (soft >= 2 && soft < text.length - 1 && soft + 1 >= minChars) {
        return { index: soft, type: 'soft' };
    }

    const strong = text.search(/[。！？!?；;]/u);
    if (strong >= 0 && strong < text.length - 1 && strong + 1 >= Math.min(8, minChars)) {
        return { index: strong, type: 'strong' };
    }

    return { index: -1, type: null };
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
