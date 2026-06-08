import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { GLOBAL_CONFIG } from '@/global_config';
import { funasrService } from '@/server/services/FunASRService';
import type { FunASRMaterialSegment } from '@/server/services/FunASRService';
import { createTaskTimer, formatBytes, type TaskTimer } from '@/server/services/cosyvoice/timing';
import type {
    CosyVoiceExtractOptions,
    CosyVoiceExtractResult,
    CosyVoiceMaterialCandidate,
    CosyVoiceSaveInput,
    CosyVoiceServiceStatus,
    CosyVoiceSpeakerProfile,
    TaskTiming,
    YtDlpAudioFormat,
    YtDlpStatus,
} from '@/server/services/cosyvoice/types';
import { normalizeTranscript } from '@tools/Voice';
import { prewarmWakeAckAudio } from '@tools/Voice';
import {
    createVoiceAssetId,
    registerVoiceAssetFile,
    safeVoiceAssetName,
    upsertVoiceSpeakerProfile,
} from '@/server/services/voice-assets';
import {
    scorePromptQuality,
    separateVoice,
} from '@/server/services/voice-assets/quality';
import {
    getCosyVoiceDataRoot,
    getVoiceAssetsDataRoot,
} from '@/server/services/voice-data-paths';
import { pipelineLogs } from '@/server/services/PipelineLogService';

const YT_DLP_VERSION = '2025.05.22';
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const ALLOWED_MEDIA_EXTENSIONS = new Set([...ALLOWED_VIDEO_EXTENSIONS, '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const MIN_PROMPT_TEXT_CHARS = 6;
const MIN_CANDIDATE_MS = 3000;
const MAX_CANDIDATE_MS = 10000;
const MAX_CANDIDATES = 12;
const MAX_SAME_SPEAKER_GAP_MS = 500;
const SPEAKER_GUARD_MS = 450;
const MANAGED_ENV_KEYS = [
    'SENTINEL_TTS_PROVIDER',
    'COSYVOICE_BASE_URL',
    'COSYVOICE_ENDPOINT',
    'COSYVOICE_SPEAKER_ID',
    'COSYVOICE_SPEAKER_NAME',
    'COSYVOICE_PROMPT_AUDIO_PATH',
    'COSYVOICE_PROMPT_TEXT',
    'COSYVOICE_TIMEOUT_MS',
    'COSYVOICE_FALLBACK_TO_SAY',
];

function getCosyVoicePaths() {
    const dataDir = getCosyVoiceDataRoot();
    const materialJobsDir = join(dataDir, 'material-jobs');
    return {
        dataDir,
        uploadDir: join(dataDir, 'source-media'),
        materialJobsDir,
        rawAudioDir: join(materialJobsDir, 'raw-audio'),
        vocalAudioDir: join(materialJobsDir, 'zero-shot-extracted'),
        slicedAudioDir: join(materialJobsDir, 'sliced-audio'),
        candidateTextDir: join(materialJobsDir, 'candidate-texts'),
        traceDir: join(materialJobsDir, 'traces'),
        selectedAudioDir: join(dataDir, 'selected-clips'),
        speakerAudioDir: join(dataDir, 'speakers'),
        speakersPath: join(dataDir, 'speakers.json'),
        wakeAckDir: join(dataDir, 'wake-ack'),
    };
}

export type {
    CosyVoiceExtractOptions,
    CosyVoiceExtractResult,
    CosyVoiceMaterialCandidate,
    CosyVoiceSaveInput,
    CosyVoiceServiceStatus,
    CosyVoiceSpeakerProfile,
    TaskTiming,
    YtDlpAudioFormat,
    YtDlpStatus,
} from '@/server/services/cosyvoice/types';

export function getCosyVoiceMaterialConfig() {
    return {
        provider: GLOBAL_CONFIG.VOICE.TTS_PROVIDER,
        baseUrl: GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL,
        endpoint: GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT,
        speakerId: GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_ID,
        speakerName: GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_NAME,
        promptAudioPath: GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_AUDIO_PATH,
        promptText: GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_TEXT,
        timeoutMs: GLOBAL_CONFIG.VOICE.COSYVOICE_TIMEOUT_MS,
        fallbackToSay: GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY,
    };
}

export async function extractCosyVoiceMaterial(video: File, options: CosyVoiceExtractOptions = {}): Promise<CosyVoiceExtractResult> {
    const timer = createTaskTimer();
    const { dataDir, uploadDir } = getCosyVoicePaths();
    validateMediaFile(video);
    await mkdir(uploadDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const videoExtension = getSafeMediaExtension(video.name, video.type);
    const uploadPath = join(uploadDir, `source-${id}${videoExtension}`);

    const uploadStartedAt = Date.now();
    await writeFile(uploadPath, Buffer.from(await video.arrayBuffer()));
    timer.mark('upload', '保存上传文件', uploadStartedAt, formatBytes(video.size));
    return extractMaterialFromVideoPath(uploadPath, options, timer);
}

export async function probeYtDlpAudioFormats(url: string): Promise<{ formats: YtDlpAudioFormat[] }> {
    const normalizedUrl = normalizeHttpUrl(url);
    const result = await runProcess(GLOBAL_CONFIG.YT_DLP.BIN, ['-J', normalizedUrl]);
    const metadata = JSON.parse(result.stdout) as { formats?: unknown[] };
    return { formats: parseYtDlpAudioFormats(metadata, normalizedUrl) };
}

export async function getYtDlpStatus(): Promise<YtDlpStatus> {
    try {
        const result = await runProcess(GLOBAL_CONFIG.YT_DLP.BIN, ['--version']);
        return {
            installed: true,
            bin: GLOBAL_CONFIG.YT_DLP.BIN,
            version: result.stdout.trim() || null,
            error: null,
        };
    } catch (error) {
        return {
            installed: false,
            bin: GLOBAL_CONFIG.YT_DLP.BIN,
            version: null,
            error: error instanceof Error ? error.message : 'yt-dlp is not available.',
        };
    }
}

export async function installYtDlp(): Promise<YtDlpStatus> {
    const targetPath = resolve(GLOBAL_CONFIG.YT_DLP.BIN);
    if (!isInsideDirectory(targetPath, resolve('data/tools/bin'))) {
        throw new Error('YT_DLP_BIN must point under data/tools/bin for automatic installation.');
    }

    await mkdir(dirname(targetPath), { recursive: true });
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp`;
    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`Failed to download yt-dlp: HTTP ${response.status}`);
    }

    await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
    await chmod(targetPath, 0o755);
    return getYtDlpStatus();
}

export async function checkCosyVoiceService(
    baseUrl = GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL,
    endpoint = GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT,
): Promise<CosyVoiceServiceStatus> {
    const serviceBaseUrl = withTrailingSlash(baseUrl.trim() || GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL);
    const healthUrl = new URL('/health', serviceBaseUrl);
    const inferenceUrl = new URL(endpoint.trim() || '/inference_zero_shot', serviceBaseUrl);
    const startedAt = Date.now();
    try {
        const response = await fetch(healthUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(2000),
        });
        const payload = await response.json().catch(() => null) as { ready?: boolean; ok?: boolean } | null;
        const ok = response.ok && Boolean(payload?.ready ?? payload?.ok);
        return {
            ok,
            url: inferenceUrl.toString(),
            status: response.status,
            error: ok ? null : `CosyVoice service is not ready at ${healthUrl.toString()}.`,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'CosyVoice service is unreachable.';
        // console.warn(`[CosyVoiceMaterial] service_check failed ms=${Date.now() - startedAt} url=${healthUrl.toString()}: ${message}`);
        return {
            ok: false,
            url: inferenceUrl.toString(),
            status: null,
            error: message,
        };
    }
}

export async function importCosyVoiceMaterialFromUrl(url: string, formatId: string, options: CosyVoiceExtractOptions = {}): Promise<CosyVoiceExtractResult> {
    const timer = createTaskTimer();
    const { uploadDir } = getCosyVoicePaths();
    const normalizedUrl = normalizeHttpUrl(url);
    const safeFormatId = normalizeYtDlpFormatId(formatId);

    await mkdir(uploadDir, { recursive: true });
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const outputTemplate = join(uploadDir, `source-${id}.%(ext)s`);
    const downloadStartedAt = Date.now();
    await runProcess(GLOBAL_CONFIG.YT_DLP.BIN, [
        '-f', safeFormatId,
        '--no-playlist',
        '-o', outputTemplate,
        normalizedUrl,
    ]);
    timer.mark('download', '下载音频资源', downloadStartedAt, safeFormatId);

    const sourcePath = await findDownloadedSourcePath(id);
    return extractMaterialFromVideoPath(sourcePath, options, timer);
}

export function createYtDlpAudioPreviewStream(url: string, formatId: string): ReadableStream<Uint8Array> {
    const normalizedUrl = normalizeHttpUrl(url);
    const safeFormatId = normalizeYtDlpFormatId(formatId);
    console.info(`[CosyVoiceMaterial] preview start format=${safeFormatId}`);

    const child = spawn(GLOBAL_CONFIG.YT_DLP.BIN, [
        '-f', safeFormatId,
        '--no-playlist',
        '-o', '-',
        normalizedUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];

    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
        console.error(`[CosyVoiceMaterial] preview spawn failed format=${safeFormatId}:`, error);
    });
    child.once('exit', (code, signal) => {
        const output = Buffer.concat(stderr).toString('utf8').trim();
        if (code === 0) {
            console.info(`[CosyVoiceMaterial] preview end format=${safeFormatId}`);
            return;
        }
        console.error(`[CosyVoiceMaterial] preview failed format=${safeFormatId} code=${code} signal=${signal}: ${output}`);
    });

    return new ReadableStream<Uint8Array>({
        start(controller) {
            child.stdout?.on('data', (chunk) => {
                controller.enqueue(Buffer.from(chunk));
            });
            child.stdout?.once('end', () => {
                controller.close();
            });
            child.stdout?.once('error', (error) => {
                controller.error(error);
            });
            child.once('error', (error) => {
                controller.error(error);
            });
        },
        cancel() {
            child.kill('SIGTERM');
            console.info(`[CosyVoiceMaterial] preview cancelled format=${safeFormatId}`);
        },
    });
}

export async function extractMaterialFromVideoPath(videoPath: string, options: CosyVoiceExtractOptions = {}, timer = createTaskTimer()): Promise<CosyVoiceExtractResult> {
    const { uploadDir, materialJobsDir, rawAudioDir, traceDir } = getCosyVoicePaths();
    const resolvedVideoPath = resolve(videoPath);
    if (!isInsideDirectory(resolvedVideoPath, uploadDir)) {
        throw new Error('videoPath must be under the managed CosyVoice source-media directory.');
    }

    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const jobId = `job-${id}`;
    const jobDir = join(materialJobsDir, jobId);
    const rawAudioPath = join(rawAudioDir, jobId, 'raw.wav');

    await mkdir(jobDir, { recursive: true });
    await mkdir(dirname(rawAudioPath), { recursive: true });
    const extractStartedAt = Date.now();
    await extractWavWithFfmpeg(resolvedVideoPath, rawAudioPath);
    timer.mark('extract_wav', '抽取 WAV', extractStartedAt, basename(resolvedVideoPath));

    let analysisPath = rawAudioPath;
    let separationResult: Awaited<ReturnType<typeof separateVoice>> | null = null;
    if (options.enhanceVocals) {
        const uvrStartedAt = Date.now();
        separationResult = await separateVoice({
            inputPath: rawAudioPath,
            reason: 'prompt-import',
            requireService: true,
        });
        analysisPath = separationResult.outputPath;
        timer.mark('mdx_separation', 'MDX 人声分离', uvrStartedAt, `${separationResult.method}${separationResult.fallbackUsed ? ' fallback' : ''}`);
    }

    const analyzeStartedAt = Date.now();
    const analysis = await funasrService.analyzeMaterial(analysisPath);
    timer.mark('funasr_analyze', 'FunASR 分析', analyzeStartedAt, `${analysis.segments.length} segments`);

    const exportStartedAt = Date.now();
    const candidates = await exportMaterialCandidates({
        jobId,
        jobDir,
        sourceAudioPath: analysisPath,
        source: analysisPath === rawAudioPath ? 'raw' : 'vocal',
        segments: analysis.segments,
        timer,
    });
    timer.mark('candidate_export', '候选导出汇总', exportStartedAt, `${candidates.length} candidates`);
    const cleanupStartedAt = Date.now();
    await cleanupExtractionArtifacts({
        uploadPath: resolvedVideoPath,
        rawAudioPath,
        analysisPath,
    });
    timer.mark('cleanup', '清理临时文件', cleanupStartedAt, basename(resolvedVideoPath));
    const finalCandidates = candidates;
    const bestCandidate = finalCandidates[0] ?? null;
    const sourceFileName = basename(resolvedVideoPath);
    const sourceExtension = extname(sourceFileName).toLowerCase();
    const sourceIsVideo = VIDEO_EXTENSIONS.has(sourceExtension);

    const timings = timer.finish();
    pipelineLogs.append({
        category: 'voice-material',
        level: 'info',
        title: 'Voice material extracted',
        message: `${finalCandidates.length} candidate(s) from ${sourceFileName}`,
        timings,
        metadata: {
            jobId,
            sourceFileName,
            sourceIsVideo,
            candidateCount: finalCandidates.length,
            bestCandidateId: bestCandidate?.id ?? null,
            enhanceVocals: Boolean(options.enhanceVocals),
            separation: separationResult ? {
                method: separationResult.method,
                fallbackUsed: separationResult.fallbackUsed,
                durationMs: separationResult.durationMs,
            } : null,
        },
    });

    return {
        audioUrl: bestCandidate?.audioUrl ?? '',
        audioPath: bestCandidate?.audioPath ?? '',
        transcript: bestCandidate?.text ?? '',
        fileName: bestCandidate ? basename(bestCandidate.audioPath) : '',
        jobId,
        metadataPath: join(jobDir, 'metadata.list'),
        tracePath: join(traceDir, jobId, 'trace.jsonl'),
        candidates: finalCandidates,
        separation: separationResult ?? undefined,
        videoUrl: sourceIsVideo ? `/api/voice/cosyvoice/video/${encodeURIComponent(sourceFileName)}` : undefined,
        videoPath: resolvedVideoPath,
        timings,
    };
}

export async function listCosyVoiceSpeakerProfiles(): Promise<CosyVoiceSpeakerProfile[]> {
    return readSpeakerProfiles();
}

export async function selectCosyVoiceSpeakerProfile(speakerId: string): Promise<{
    config: ReturnType<typeof getCosyVoiceMaterialConfig>;
    speakers: CosyVoiceSpeakerProfile[];
    timings?: TaskTiming[];
}> {
    const timer = createTaskTimer();
    const speaker = (await readSpeakerProfiles()).find(item => item.id === speakerId);
    if (!speaker) {
        throw new Error('speaker profile not found.');
    }

    const cacheStartedAt = Date.now();
    await cacheSpeakerInCosyVoiceService(
        GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL,
        speaker.id,
        speaker.promptText,
        speaker.promptAudioPath,
    );
    timer.mark('cache_speaker', 'CosyVoice 缓存', cacheStartedAt, speaker.id);
    const applyStartedAt = Date.now();
    await applyActiveCosyVoiceMaterial({
        provider: GLOBAL_CONFIG.VOICE.TTS_PROVIDER,
        baseUrl: GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL,
        endpoint: GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT,
        speakerId: speaker.id,
        speakerName: speaker.name,
        promptAudioPath: speaker.promptAudioPath,
        promptText: speaker.promptText,
        timeoutMs: GLOBAL_CONFIG.VOICE.COSYVOICE_TIMEOUT_MS,
        fallbackToSay: GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY,
    });
    timer.mark('apply_config', '应用配置', applyStartedAt, speaker.name);

    const timings = timer.finish();
    pipelineLogs.append({
        category: 'voice-material',
        level: 'info',
        title: 'Voice speaker profile applied',
        message: speaker.name,
        timings,
        metadata: {
            speakerId: speaker.id,
            speakerName: speaker.name,
            promptAudioPath: speaker.promptAudioPath,
            promptTextChars: speaker.promptText.length,
        },
    });

    return {
        config: getCosyVoiceMaterialConfig(),
        speakers: await readSpeakerProfiles(),
        timings,
    };
}

export async function deleteCosyVoiceSpeakerProfile(speakerId: string): Promise<{
    config: ReturnType<typeof getCosyVoiceMaterialConfig>;
    speakers: CosyVoiceSpeakerProfile[];
    deleted: boolean;
}> {
    const id = speakerId.trim();
    if (!id) {
        throw new Error('speakerId is required.');
    }

    const speakers = await readSpeakerProfiles();
    const nextSpeakers = speakers.filter(item => item.id !== id);
    if (nextSpeakers.length === speakers.length) {
        throw new Error('speaker profile not found.');
    }

    await writeSpeakerProfiles(nextSpeakers);
    if (GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_ID === id) {
        await applyActiveCosyVoiceMaterial({
            provider: GLOBAL_CONFIG.VOICE.TTS_PROVIDER,
            baseUrl: GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL,
            endpoint: GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT,
            speakerId: '',
            speakerName: '默认音色',
            promptAudioPath: '',
            promptText: '',
            timeoutMs: GLOBAL_CONFIG.VOICE.COSYVOICE_TIMEOUT_MS,
            fallbackToSay: GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY,
        }, { skipPromptValidation: true });
    }

    return {
        config: getCosyVoiceMaterialConfig(),
        speakers: nextSpeakers,
        deleted: true,
    };
}

export async function saveCosyVoiceMaterial(input: CosyVoiceSaveInput): Promise<{
    config: ReturnType<typeof getCosyVoiceMaterialConfig>;
    speakers: CosyVoiceSpeakerProfile[];
    speaker: CosyVoiceSpeakerProfile;
    cached: boolean;
    cacheWarning?: string;
    timings?: TaskTiming[];
}> {
    const timer = createTaskTimer();
    const normalized = normalizeSaveInput(input);
    const saveStartedAt = Date.now();
    const sourceAudioPath = await assertManagedAudioPath(normalized.promptAudioPath);
    const audioPath = await persistSpeakerPromptAudio(sourceAudioPath, normalized.speakerName, normalized.speakerId);
    const speaker = await upsertSpeakerProfile({
        speakerId: normalized.speakerId,
        speakerName: normalized.speakerName,
        promptAudioPath: audioPath,
        promptText: normalized.promptText,
    });
    timer.mark('save_profile', '保存音色资料', saveStartedAt, speaker.id);

    let cacheWarning: string | undefined;
    let cached = false;
    const cacheStartedAt = Date.now();
    try {
        await cacheSpeakerInCosyVoiceService(
            normalized.baseUrl,
            speaker.id,
            speaker.promptText,
            speaker.promptAudioPath,
        );
        cached = true;
        timer.mark('cache_speaker', 'CosyVoice 缓存', cacheStartedAt, speaker.id);
    } catch (error) {
        cacheWarning = error instanceof Error ? error.message : 'CosyVoice speaker cache failed.';
        timer.mark('cache_speaker', 'CosyVoice 缓存', cacheStartedAt, `failed: ${cacheWarning.slice(0, 120)}`);
        console.warn(`[CosyVoiceMaterial] speaker saved but cache failed id=${speaker.id}: ${cacheWarning}`);
    }

    const applyStartedAt = Date.now();
    await applyActiveCosyVoiceMaterial({
        ...normalized,
        speakerId: speaker.id,
        speakerName: speaker.name,
        promptAudioPath: audioPath,
    });
    timer.mark('apply_config', '应用配置', applyStartedAt, speaker.name);

    const wakeAckStartedAt = Date.now();
    await prewarmWakeAckAudio().catch((error) => {
        console.warn(`[CosyVoiceMaterial] wake ack prewarm failed id=${speaker.id}:`, error);
    });
    timer.mark('wake_ack_prewarm', '唤醒应答预热', wakeAckStartedAt, speaker.id);
    const assetStartedAt = Date.now();
    await registerSpeakerVoiceAsset(speaker);
    timer.mark('voice_asset_index', 'VoiceAsset 索引', assetStartedAt, speaker.id);

    const cleanupStartedAt = Date.now();
    await cleanupMaterialExtraction(sourceAudioPath);
    timer.mark('cleanup', '清理临时文件', cleanupStartedAt, basename(sourceAudioPath));

    const timings = timer.finish();
    pipelineLogs.append({
        category: 'voice-material',
        level: cacheWarning ? 'warn' : 'info',
        title: 'Voice speaker profile saved',
        message: speaker.name,
        timings,
        metadata: {
            speakerId: speaker.id,
            speakerName: speaker.name,
            cached,
            cacheWarning: cacheWarning ?? null,
            promptAudioPath: speaker.promptAudioPath,
            promptTextChars: speaker.promptText.length,
        },
    });

    return {
        config: getCosyVoiceMaterialConfig(),
        speakers: await readSpeakerProfiles(),
        speaker,
        cached,
        cacheWarning,
        timings,
    };
}

async function applyActiveCosyVoiceMaterial(
    normalized: CosyVoiceSaveInput & { speakerId: string; speakerName: string },
    options: { skipPromptValidation?: boolean } = {},
): Promise<void> {
    if (!options.skipPromptValidation && !normalized.promptText.trim()) {
        throw new Error('promptText is required.');
    }

    await updateEnvLocal({
        SENTINEL_TTS_PROVIDER: normalized.provider,
        COSYVOICE_BASE_URL: normalized.baseUrl,
        COSYVOICE_ENDPOINT: normalized.endpoint,
        COSYVOICE_SPEAKER_ID: normalized.speakerId,
        COSYVOICE_SPEAKER_NAME: normalized.speakerName,
        COSYVOICE_PROMPT_AUDIO_PATH: normalized.promptAudioPath,
        COSYVOICE_PROMPT_TEXT: normalized.promptText,
        COSYVOICE_TIMEOUT_MS: String(normalized.timeoutMs),
        COSYVOICE_FALLBACK_TO_SAY: normalized.fallbackToSay ? '1' : '0',
    });

    process.env.SENTINEL_TTS_PROVIDER = normalized.provider;
    process.env.COSYVOICE_BASE_URL = normalized.baseUrl;
    process.env.COSYVOICE_ENDPOINT = normalized.endpoint;
    process.env.COSYVOICE_SPEAKER_ID = normalized.speakerId;
    process.env.COSYVOICE_SPEAKER_NAME = normalized.speakerName;
    process.env.COSYVOICE_PROMPT_AUDIO_PATH = normalized.promptAudioPath;
    process.env.COSYVOICE_PROMPT_TEXT = normalized.promptText;
    process.env.COSYVOICE_TIMEOUT_MS = String(normalized.timeoutMs);
    process.env.COSYVOICE_FALLBACK_TO_SAY = normalized.fallbackToSay ? '1' : '0';

    GLOBAL_CONFIG.VOICE.TTS_PROVIDER = normalized.provider;
    GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL = normalized.baseUrl;
    GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT = normalized.endpoint;
    GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_ID = normalized.speakerId;
    GLOBAL_CONFIG.VOICE.COSYVOICE_SPEAKER_NAME = normalized.speakerName;
    GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_AUDIO_PATH = normalized.promptAudioPath;
    GLOBAL_CONFIG.VOICE.COSYVOICE_PROMPT_TEXT = normalized.promptText;
    GLOBAL_CONFIG.VOICE.COSYVOICE_TIMEOUT_MS = normalized.timeoutMs;
    GLOBAL_CONFIG.VOICE.COSYVOICE_FALLBACK_TO_SAY = normalized.fallbackToSay;
}

export async function resolveCosyVoiceAudioFile(fileName: string): Promise<string | null> {
    const { dataDir } = getCosyVoicePaths();
    const safeName = decodeURIComponent(fileName).replace(/\\/gu, '/');
    if (safeName.includes('..') || !safeName.endsWith('.wav')) return null;

    const roots = safeName.startsWith('voice-assets/') || safeName.startsWith('assets/')
        ? [getVoiceAssetsDataRoot()]
        : [dataDir];
    const relativePath = safeName.startsWith('voice-assets/')
        ? safeName.slice('voice-assets/'.length)
        : safeName.startsWith('assets/')
            ? safeName.slice('assets/'.length)
            : safeName;

    for (const rootDir of roots) {
        const audioPath = resolve(rootDir, relativePath);
        if (!isInsideDirectory(audioPath, rootDir)) continue;
        const exists = await stat(audioPath).then(item => item.isFile()).catch(() => false);
        if (exists) return audioPath;
    }

    return null;
}

export async function resolveCosyVoiceVideoFile(fileName: string): Promise<string | null> {
    const { uploadDir } = getCosyVoicePaths();
    const safeName = basename(decodeURIComponent(fileName));
    const videoPath = resolve(uploadDir, safeName);
    if (!isInsideDirectory(videoPath, uploadDir)) return null;

    const exists = await stat(videoPath).then(item => item.isFile()).catch(() => false);
    return exists ? videoPath : null;
}

export function isManagedCosyVoiceAudioPath(path: string): boolean {
    const { dataDir } = getCosyVoicePaths();
    const resolved = resolve(path);
    return (
        isInsideDirectory(resolved, dataDir)
        || isInsideDirectory(resolved, getVoiceAssetsDataRoot())
    )
        && resolved.endsWith('.wav');
}

export function parseFunASRMaterialCandidates(segments: FunASRMaterialSegment[]): Array<FunASRMaterialSegment & { durationMs: number; reasons: string[]; score: number }> {
    const sorted = segments
        .map(segment => ({
            ...segment,
            start_ms: Math.max(0, Math.round(segment.start_ms)),
            end_ms: Math.max(0, Math.round(segment.end_ms)),
            text: normalizeTranscript(segment.text),
            spk: segment.spk || 'SPK0',
        }))
        .sort((left, right) => left.start_ms - right.start_ms);

    const directCandidates = sorted
        .map((segment, index) => {
            const durationMs = segment.end_ms - segment.start_ms;
            const reasons: string[] = [];
            if (durationMs < MIN_CANDIDATE_MS) reasons.push('too_short');
            if (durationMs > MAX_CANDIDATE_MS) reasons.push('too_long');
            if (!segment.text || countPromptTextChars(segment.text) < MIN_PROMPT_TEXT_CHARS) reasons.push('text_too_short');
            if (hasSuspiciousTranscript(segment.text)) reasons.push('suspicious_text');
            const previous = sorted[index - 1];
            const next = sorted[index + 1];
            if ((previous && previous.end_ms > segment.start_ms) || (next && segment.end_ms > next.start_ms)) {
                reasons.push('overlap');
            }
            if (hasSpeakerGuardConflict(segment, sorted, index, index)) {
                reasons.push('speaker_too_close');
            }
            return {
                ...segment,
                durationMs,
                reasons,
                score: 0,
            };
        })
        .filter(segment => segment.reasons.length === 0)
        .map(segment => ({ ...segment, score: rankSegment(segment) }));

    return [
        ...directCandidates,
        ...buildMergedSpeakerCandidates(sorted),
    ].sort((left, right) => left.start_ms - right.start_ms);
}

export function parseYtDlpAudioFormats(metadata: { formats?: unknown[] }, sourceUrl = ''): YtDlpAudioFormat[] {
    const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
    return formats
        .map(format => parseYtDlpFormat(format, sourceUrl))
        .filter((format): format is YtDlpAudioFormat => format !== null);
}

async function assertManagedAudioPath(path: string): Promise<string> {
    const resolved = resolve(path);
    if (!isManagedCosyVoiceAudioPath(resolved)) {
        throw new Error('promptAudioPath must be a wav file generated under managed voice data.');
    }

    const fileExists = await stat(resolved).then(item => item.isFile()).catch(() => false);
    if (!fileExists) {
        throw new Error('promptAudioPath does not exist.');
    }

    return resolved;
}

async function persistSpeakerPromptAudio(sourceAudioPath: string, speakerName: string, speakerId?: string): Promise<string> {
    const { selectedAudioDir, speakerAudioDir } = getCosyVoicePaths();
    if (isInsideDirectory(sourceAudioPath, speakerAudioDir)) {
        return sourceAudioPath;
    }

    await mkdir(selectedAudioDir, { recursive: true });
    await mkdir(speakerAudioDir, { recursive: true });
    const baseName = safeFilePart(speakerId || speakerName || 'speaker');
    const selectedPath = resolve(selectedAudioDir, `${baseName}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.wav`);
    if (!isInsideDirectory(selectedPath, selectedAudioDir)) {
        throw new Error('Invalid selected audio target path.');
    }
    await copyFile(sourceAudioPath, selectedPath);

    const targetPath = resolve(speakerAudioDir, `${baseName}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.wav`);
    if (!isInsideDirectory(targetPath, speakerAudioDir)) {
        throw new Error('Invalid speaker audio target path.');
    }

    await copyFile(selectedPath, targetPath);
    return targetPath;
}

async function cleanupExtractionArtifacts(input: {
    uploadPath: string;
    rawAudioPath: string;
    analysisPath: string;
}): Promise<void> {
    const { uploadDir } = getCosyVoicePaths();
    await removeSafeFile(input.uploadPath, uploadDir);
}

async function removeSafeFile(path: string, root: string): Promise<void> {
    const resolved = resolve(path);
    if (!isInsideDirectory(resolved, root)) {
        return;
    }
    await rm(resolved, { force: true }).catch(() => undefined);
}

async function cleanupMaterialExtraction(sourceAudioPath: string): Promise<void> {
    const { dataDir } = getCosyVoicePaths();
    const source = resolve(sourceAudioPath);
    if (!isInsideDirectory(source, dataDir)) {
        return;
    }

    const jobId = findJobId(source);
    if (!jobId) {
        return;
    }

    await removeMaterialJobArtifacts(jobId);
}

function findJobId(path: string): string | null {
    for (const part of resolve(path).split(/[\\/]+/u)) {
        if (part.startsWith('job-')) {
            return part;
        }
    }
    return null;
}

async function removeMaterialJobArtifacts(jobId: string): Promise<void> {
    const {
        materialJobsDir,
        rawAudioDir,
        vocalAudioDir,
        slicedAudioDir,
        candidateTextDir,
        traceDir,
    } = getCosyVoicePaths();
    const roots = [materialJobsDir, rawAudioDir, vocalAudioDir, slicedAudioDir, candidateTextDir, traceDir];
    await Promise.all(roots.map(root => {
        const target = resolve(root, jobId);
        return isInsideDirectory(target, root)
            ? rm(target, { recursive: true, force: true }).catch(() => undefined)
            : Promise.resolve();
    }));
}

function validateMediaFile(video: File): void {
    if (!(video instanceof File) || video.size === 0) {
        throw new Error('video is required.');
    }
    const extension = extname(video.name).toLowerCase();
    if (!video.type.startsWith('video/') && !video.type.startsWith('audio/') && !ALLOWED_MEDIA_EXTENSIONS.has(extension)) {
        throw new Error('Only video and audio files are supported.');
    }
}

function getSafeMediaExtension(name: string, mimeType: string): string {
    const extension = extname(name).toLowerCase();
    if (ALLOWED_MEDIA_EXTENSIONS.has(extension)) return extension;
    if (mimeType === 'audio/wav') return '.wav';
    if (mimeType === 'audio/mpeg') return '.mp3';
    if (mimeType === 'audio/mp4') return '.m4a';
    if (mimeType === 'video/webm') return '.webm';
    if (mimeType === 'video/quicktime') return '.mov';
    return '.mp4';
}

async function createVocalWav(rawAudioPath: string, jobDir: string): Promise<string> {
    const command = GLOBAL_CONFIG.VOICE.UVR5_CMD.trim();
    if (!command) {
        throw new Error('UVR5_CMD is not configured. Disable vocal enhancement or configure a UVR5 CLI command.');
    }
    const { vocalAudioDir } = getCosyVoicePaths();
    const jobId = basename(jobDir);
    const vocalPath = join(vocalAudioDir, jobId, 'vocal.wav');
    await mkdir(dirname(vocalPath), { recursive: true });
    const parts = command.split(' ').filter(Boolean);
    const executable = parts[0]!;
    const args = parts.slice(1)
        .map(arg => arg.replace('{input}', rawAudioPath).replace('{output}', vocalPath));
    if (!command.includes('{input}') || !command.includes('{output}')) {
        args.push(rawAudioPath, vocalPath);
    }
    await runProcess(executable, args);
    const exists = await stat(vocalPath).then(item => item.isFile()).catch(() => false);
    if (!exists) {
        throw new Error('UVR5 did not produce vocal.wav.');
    }
    return vocalPath;
}

async function exportMaterialCandidates(input: {
    jobId: string;
    jobDir: string;
    sourceAudioPath: string;
    source: 'raw' | 'vocal';
    segments: FunASRMaterialSegment[];
    timer?: TaskTimer;
}): Promise<CosyVoiceMaterialCandidate[]> {
    const { slicedAudioDir, candidateTextDir } = getCosyVoicePaths();
    const clipsDir = join(slicedAudioDir, input.jobId);
    const textsDir = join(candidateTextDir, input.jobId);
    await mkdir(clipsDir, { recursive: true });
    await mkdir(textsDir, { recursive: true });

    const allSegments = buildTraceSegments(input.segments);
    await writeTrace(input.jobDir, allSegments);

    const filterStartedAt = Date.now();
    const accepted = parseFunASRMaterialCandidates(input.segments)
        .sort((left, right) => rankSegment(right) - rankSegment(left))
        .slice(0, MAX_CANDIDATES);
    input.timer?.mark('candidate_filter', '候选过滤', filterStartedAt, `${accepted.length}/${input.segments.length} accepted`);
    const candidates: CosyVoiceMaterialCandidate[] = [];

    for (const [index, segment] of accepted.entries()) {
        const cutStartedAt = Date.now();
        const speaker = safeFilePart(segment.spk);
        const clipName = `${speaker}-${String(index + 1).padStart(2, '0')}.wav`;
        const textName = `${speaker}-${String(index + 1).padStart(2, '0')}.txt`;
        const audioPath = join(clipsDir, clipName);
        const textPath = join(textsDir, textName);
        await cutWavWithFfmpeg(input.sourceAudioPath, audioPath, segment.start_ms, segment.end_ms);
        const verifiedText = normalizeTranscript(await funasrService.transcribe(audioPath)) || segment.text;
        const qualityScore = await scorePromptQuality(audioPath).catch(() => undefined);
        await writeFile(textPath, `${verifiedText}\n`, 'utf8');
        input.timer?.mark('candidate_cut', '候选切片复核', cutStartedAt, clipName);
        const candidate: CosyVoiceMaterialCandidate = {
            id: `${input.jobId}-${index + 1}`,
            speaker: segment.spk,
            startMs: segment.start_ms,
            endMs: segment.end_ms,
            durationMs: segment.durationMs,
            text: verifiedText,
            quality: (qualityScore?.score ?? segment.score * 100) >= 78 ? 'high' : 'medium',
            reasons: segment.reasons,
            score: segment.score,
            qualityScore,
            audioPath,
            audioUrl: toCosyVoiceAudioUrl(audioPath),
            textPath,
            source: input.source,
        };
        candidates.push(candidate);
        await registerVoiceAssetFile({
            kind: 'candidate',
            sourcePath: audioPath,
            copy: false,
            assetId: createVoiceAssetId('candidate'),
            metadata: {
                jobId: input.jobId,
                speaker: segment.spk,
                source: input.source,
                sourceAudioPath: input.sourceAudioPath,
                text: verifiedText,
                startMs: segment.start_ms,
                endMs: segment.end_ms,
                durationMs: segment.durationMs,
                rankScore: segment.score,
                qualityScore,
            },
        });
    }

    const metadataStartedAt = Date.now();
    await writeMetadata(input.jobDir, candidates);
    input.timer?.mark('metadata', '写入 metadata', metadataStartedAt, 'metadata.list');
    return candidates;
}

function buildTraceSegments(segments: FunASRMaterialSegment[]): Array<{
    startMs: number;
    endMs: number;
    text: string;
    speaker: string;
    accepted: boolean;
    reasons: string[];
}> {
    const accepted = new Set(parseFunASRMaterialCandidates(segments).map(segment => `${segment.start_ms}:${segment.end_ms}:${segment.spk}`));
    return segments.map(segment => {
        const normalized = normalizeTranscript(segment.text);
        const reasons = segmentRejectReasons(segment, normalized, segments);
        return {
            startMs: segment.start_ms,
            endMs: segment.end_ms,
            text: normalized,
            speaker: segment.spk || 'SPK0',
            accepted: accepted.has(`${segment.start_ms}:${segment.end_ms}:${segment.spk || 'SPK0'}`),
            reasons,
        };
    });
}

function buildMergedSpeakerCandidates(
    sorted: Array<FunASRMaterialSegment & { start_ms: number; end_ms: number; text: string; spk: string }>,
): Array<FunASRMaterialSegment & { durationMs: number; reasons: string[]; score: number }> {
    const candidates: Array<FunASRMaterialSegment & { durationMs: number; reasons: string[]; score: number }> = [];
    for (let startIndex = 0; startIndex < sorted.length; startIndex += 1) {
        let text = '';
        let endMs = sorted[startIndex]!.end_ms;
        const start = sorted[startIndex]!;
        if (!start.text || hasSuspiciousTranscript(start.text)) continue;

        for (let index = startIndex; index < sorted.length; index += 1) {
            const segment = sorted[index]!;
            const previous = sorted[index - 1];
            if (segment.spk !== start.spk) break;
            if (previous && index > startIndex && segment.start_ms - previous.end_ms > MAX_SAME_SPEAKER_GAP_MS) break;
            if (hasSuspiciousTranscript(segment.text)) break;

            const nextText = [text, segment.text].filter(Boolean).join('');
            const nextDuration = segment.end_ms - start.start_ms;
            if (nextDuration > MAX_CANDIDATE_MS) break;

            text = nextText;
            endMs = segment.end_ms;
            if (nextDuration >= MIN_CANDIDATE_MS
                && countPromptTextChars(text) >= MIN_PROMPT_TEXT_CHARS
                && !hasSpeakerGuardConflict({ ...start, end_ms: endMs }, sorted, startIndex, index)) {
                const candidate = {
                    start_ms: start.start_ms,
                    end_ms: endMs,
                    text,
                    spk: start.spk,
                    confidence: start.confidence ?? null,
                    durationMs: nextDuration,
                    reasons: [],
                    score: 0,
                };
                candidates.push({
                    ...candidate,
                    score: rankSegment(candidate),
                });
            }
        }
    }

    return dedupeMergedCandidates(candidates);
}

function dedupeMergedCandidates(
    candidates: Array<FunASRMaterialSegment & { durationMs: number; reasons: string[]; score: number }>,
): Array<FunASRMaterialSegment & { durationMs: number; reasons: string[]; score: number }> {
    const seen = new Set<string>();
    const unique: Array<FunASRMaterialSegment & { durationMs: number; reasons: string[]; score: number }> = [];
    for (const candidate of [...candidates].sort((left, right) => rankSegment(right) - rankSegment(left))) {
        const key = `${candidate.spk}:${candidate.start_ms}:${candidate.end_ms}:${candidate.text}`;
        if (seen.has(key)) continue;
        if (unique.some(item => item.spk === candidate.spk && item.start_ms <= candidate.start_ms && item.end_ms >= candidate.end_ms)) {
            continue;
        }
        seen.add(key);
        unique.push(candidate);
    }
    return unique;
}

function hasSpeakerGuardConflict(
    segment: { start_ms: number; end_ms: number; spk: string },
    sorted: Array<{ start_ms: number; end_ms: number; spk: string }>,
    startIndex: number,
    endIndex: number,
): boolean {
    const previous = sorted[startIndex - 1];
    const next = sorted[endIndex + 1];
    return !!((previous && previous.spk !== segment.spk && segment.start_ms - previous.end_ms < SPEAKER_GUARD_MS)
        || (next && next.spk !== segment.spk && next.start_ms - segment.end_ms < SPEAKER_GUARD_MS));
}

function segmentRejectReasons(segment: FunASRMaterialSegment, text: string, allSegments: FunASRMaterialSegment[]): string[] {
    const durationMs = segment.end_ms - segment.start_ms;
    const reasons: string[] = [];
    if (durationMs < MIN_CANDIDATE_MS) reasons.push('too_short');
    if (durationMs > MAX_CANDIDATE_MS) reasons.push('too_long');
    if (!text || countPromptTextChars(text) < MIN_PROMPT_TEXT_CHARS) reasons.push('text_too_short');
    if (hasSuspiciousTranscript(text)) reasons.push('suspicious_text');
    if (allSegments.some(other => other !== segment && other.start_ms < segment.end_ms && segment.start_ms < other.end_ms)) {
        reasons.push('overlap');
    }
    return reasons;
}

function rankSegment(segment: FunASRMaterialSegment & { durationMs: number }): number {
    const durationScore = 1 - Math.min(Math.abs(segment.durationMs - 6000) / 6000, 1);
    const textScore = Math.min(countPromptTextChars(segment.text) / 24, 1);
    const confidenceScore = typeof segment.confidence === 'number' ? Math.max(0, Math.min(segment.confidence, 1)) : 0.7;
    return durationScore * 0.45 + textScore * 0.35 + confidenceScore * 0.2;
}

function hasSuspiciousTranscript(text: string): boolean {
    if (!text) return true;
    if (/^(啊|嗯|呃|哦|喂|哈|呵)+[。！？!?.，,]*$/u.test(text)) return true;
    if (/(音乐|掌声|笑声|字幕|谢谢观看)/u.test(text)) return true;
    return false;
}

async function writeMetadata(jobDir: string, candidates: CosyVoiceMaterialCandidate[]): Promise<void> {
    const content = candidates.map(candidate => `${candidate.audioPath}|${candidate.text}`).join('\n');
    await writeFile(join(jobDir, 'metadata.list'), `${content}${content ? '\n' : ''}`, 'utf8');
}

async function writeTrace(jobDir: string, rows: unknown[]): Promise<void> {
    const { traceDir } = getCosyVoicePaths();
    const targetPath = join(traceDir, basename(jobDir), 'trace.jsonl');
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function toCosyVoiceAudioUrl(audioPath: string): string {
    const { dataDir } = getCosyVoicePaths();
    const resolvedAudioPath = resolve(audioPath);
    let relativePath = relative(dataDir, resolvedAudioPath);
    const assetRoot = getVoiceAssetsDataRoot();
    if (isInsideDirectory(resolvedAudioPath, assetRoot)) {
        relativePath = `voice-assets/${relative(assetRoot, resolvedAudioPath)}`;
    }
    return `/api/voice/cosyvoice/audio/${encodeURIComponent(relativePath)}`;
}

function safeFilePart(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-').replace(/^-+|-+$/gu, '') || 'spk0';
}

function extractWavWithFfmpeg(inputPath: string, outputPath: string): Promise<void> {
    return runProcess(
        GLOBAL_CONFIG.FFMPEG.BIN,
        [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', inputPath,
            '-vn',
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            outputPath,
        ],
    ).then(() => undefined);
}

function cutWavWithFfmpeg(inputPath: string, outputPath: string, startMs: number, endMs: number): Promise<void> {
    const startSeconds = Math.max(0, startMs / 1000);
    const durationSeconds = Math.max(0.1, (endMs - startMs) / 1000);
    return runProcess(
        GLOBAL_CONFIG.FFMPEG.BIN,
        [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-ss', startSeconds.toFixed(3),
            '-t', durationSeconds.toFixed(3),
            '-i', inputPath,
            '-vn',
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            outputPath,
        ],
    ).then(() => undefined);
}

function normalizeSaveInput(input: CosyVoiceSaveInput): CosyVoiceSaveInput {
    const provider = input.provider === 'say' ? 'say' : 'cosyvoice';
    const baseUrl = input.baseUrl.trim() || GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL;
    const endpoint = input.endpoint.trim() || '/inference_zero_shot';
    const promptText = input.promptText.trim();
    const speakerName = input.speakerName.trim() || '默认音色';
    const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? Math.round(input.timeoutMs) : 30000;

    if (!promptText) {
        throw new Error('promptText is required.');
    }
    if (countPromptTextChars(promptText) < MIN_PROMPT_TEXT_CHARS) {
        throw new Error(`promptText must contain at least ${MIN_PROMPT_TEXT_CHARS} spoken characters for MLX zero-shot voice cloning.`);
    }

    return {
        provider,
        baseUrl,
        endpoint,
        speakerId: input.speakerId?.trim(),
        speakerName,
        promptAudioPath: input.promptAudioPath.trim(),
        promptText,
        timeoutMs,
        fallbackToSay: input.fallbackToSay,
    };
}

async function readSpeakerProfiles(): Promise<CosyVoiceSpeakerProfile[]> {
    const { speakersPath } = getCosyVoicePaths();
    if (!existsSync(speakersPath)) {
        return [];
    }

    const content = await readFile(speakersPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter(isSpeakerProfile);
}

async function writeSpeakerProfiles(speakers: CosyVoiceSpeakerProfile[]): Promise<void> {
    const { dataDir, speakersPath } = getCosyVoicePaths();
    await mkdir(dataDir, { recursive: true });
    await writeFile(speakersPath, `${JSON.stringify(speakers, null, 2)}\n`, 'utf8');
}

async function upsertSpeakerProfile(input: {
    speakerId?: string;
    speakerName: string;
    promptAudioPath: string;
    promptText: string;
}): Promise<CosyVoiceSpeakerProfile> {
    const speakers = await readSpeakerProfiles();
    const now = new Date().toISOString();
    const existingIndex = input.speakerId
        ? speakers.findIndex(item => item.id === input.speakerId)
        : -1;
    const existing = existingIndex >= 0 ? speakers[existingIndex] ?? null : null;
    const speaker: CosyVoiceSpeakerProfile = {
        id: existing?.id ?? createSpeakerId(input.speakerName),
        name: input.speakerName,
        promptAudioPath: input.promptAudioPath,
        promptText: input.promptText,
        promptList: mergePromptList(existing, input.promptAudioPath, input.promptText),
        benchmarkResults: existing?.benchmarkResults ?? [],
        cachedResponses: existing?.cachedResponses ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };

    if (existingIndex >= 0) {
        speakers[existingIndex] = speaker;
    } else {
        speakers.push(speaker);
    }
    await writeSpeakerProfiles(speakers);
    return speaker;
}

function mergePromptList(
    existing: CosyVoiceSpeakerProfile | null,
    promptAudioPath: string,
    promptText: string,
): NonNullable<CosyVoiceSpeakerProfile['promptList']> {
    const now = new Date().toISOString();
    const current = existing?.promptList ?? [];
    const withoutDuplicate = current.filter(item => item.audioPath !== promptAudioPath);
    return [
        {
            id: safeVoiceAssetName(`${basename(promptAudioPath)}-${Date.now().toString(36)}`),
            audioPath: promptAudioPath,
            text: promptText,
            createdAt: now,
        },
        ...withoutDuplicate,
    ];
}

async function registerSpeakerVoiceAsset(speaker: CosyVoiceSpeakerProfile): Promise<void> {
    const promptAsset = await registerVoiceAssetFile({
        kind: 'speaker_prompt',
        sourcePath: speaker.promptAudioPath,
        copy: false,
        assetId: `speaker-prompt-${speaker.id}`,
        metadata: {
            speakerId: speaker.id,
            speakerName: speaker.name,
            promptText: speaker.promptText,
        },
    });
    await upsertVoiceSpeakerProfile({
        speakerId: speaker.id,
        speakerName: speaker.name,
        promptList: [
            promptAsset.id,
            ...(speaker.promptList ?? [])
                .map(prompt => prompt.id)
                .filter(id => id !== promptAsset.id),
        ],
        benchmarkResults: speaker.benchmarkResults ?? [],
        cachedResponses: speaker.cachedResponses ?? [],
        createdAt: speaker.createdAt,
        updatedAt: speaker.updatedAt,
        metadata: {
            activePromptAudioPath: speaker.promptAudioPath,
            activePromptText: speaker.promptText,
        },
    });
}

async function cacheSpeakerInCosyVoiceService(baseUrl: string, speakerId: string, promptText: string, promptAudioPath: string): Promise<void> {
    if (countPromptTextChars(promptText) < MIN_PROMPT_TEXT_CHARS) {
        throw new Error(`promptText must contain at least ${MIN_PROMPT_TEXT_CHARS} spoken characters for MLX zero-shot voice cloning.`);
    }

    const url = new URL('/speaker/cache', normalizeLocalBaseUrl(baseUrl.trim() || GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL));
    const form = new FormData();
    form.set('zero_shot_spk_id', speakerId);
    form.set('prompt_text', promptText);
    form.set('prompt_wav', Bun.file(promptAudioPath));

    const startedAt = Date.now();
    console.info(`[CosyVoiceMaterial] cache_speaker start id=${speakerId} url=${url.toString()}`);
    const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`CosyVoice speaker cache failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
    }
    console.info(`[CosyVoiceMaterial] cache_speaker ok id=${speakerId} ms=${Date.now() - startedAt}`);
}

function createSpeakerId(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 32) || 'speaker';
    return `${slug}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function isSpeakerProfile(value: unknown): value is CosyVoiceSpeakerProfile {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === 'string'
        && typeof item.name === 'string'
        && typeof item.promptAudioPath === 'string'
        && typeof item.promptText === 'string'
        && typeof item.createdAt === 'string'
        && typeof item.updatedAt === 'string';
}

async function updateEnvLocal(values: Record<string, string>): Promise<void> {
    const envPath = resolve('.env.local');
    const lines = existsSync(envPath)
        ? (await readFile(envPath, 'utf8')).split(/\r?\n/)
        : [];
    const nextLines: string[] = [];
    const written = new Set<string>();

    for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        const key = match?.[1];
        if (key && MANAGED_ENV_KEYS.includes(key)) {
            if (!written.has(key)) {
                nextLines.push(`${key}=${formatEnvValue(values[key] ?? '')}`);
                written.add(key);
            }
            continue;
        }
        nextLines.push(line);
    }

    for (const key of MANAGED_ENV_KEYS) {
        if (!written.has(key)) {
            nextLines.push(`${key}=${formatEnvValue(values[key] ?? '')}`);
        }
    }

    await writeFile(envPath, `${nextLines.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
}

function formatEnvValue(value: string): string {
    if (/^[A-Za-z0-9_./: -]*$/u.test(value) && !value.includes('\n')) {
        return value;
    }
    return JSON.stringify(value);
}

function isInsideDirectory(path: string, directory: string): boolean {
    const relativePath = relative(resolve(directory), resolve(path));
    return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveProcess, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
        child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
        child.once('error', (error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new Error(`${command} is not installed or not found in PATH.`));
                return;
            }
            reject(error);
        });
        child.once('exit', (code, signal) => {
            const output = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            };
            if (code === 0) {
                resolveProcess(output);
                return;
            }
            reject(new Error(`${command} failed code=${code}, signal=${signal}: ${output.stderr.trim()}`));
        });
    });
}

function normalizeHttpUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error('url is required.');
    }
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http and https URLs are supported.');
    }
    return parsed.toString();
}

function normalizeYtDlpFormatId(formatId: string): string {
    const safeFormatId = formatId.trim();
    if (!safeFormatId || /[^A-Za-z0-9+_,.:/-]/u.test(safeFormatId)) {
        throw new Error('formatId is required.');
    }
    return safeFormatId;
}

function parseYtDlpFormat(value: unknown, sourceUrl: string): YtDlpAudioFormat | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    const formatId = typeof item.format_id === 'string' ? item.format_id : '';
    const vcodec = typeof item.vcodec === 'string' ? item.vcodec : '';
    const acodec = typeof item.acodec === 'string' ? item.acodec : 'unknown';
    if (!formatId || vcodec !== 'none' || !acodec || acodec === 'none') return null;

    const ext = typeof item.ext === 'string' ? item.ext : '';
    const resolution = 'audio only';
    const fps = typeof item.fps === 'number' ? item.fps : null;
    const filesize = typeof item.filesize === 'number'
        ? item.filesize
        : typeof item.filesize_approx === 'number'
            ? item.filesize_approx
            : null;
    const protocol = typeof item.protocol === 'string' ? item.protocol : '';
    const label = [
        'audio-only',
        ext,
        acodec,
        filesize ? formatBytes(filesize) : '',
    ].filter(Boolean).join(' · ');

    return {
        formatId,
        label,
        ext,
        resolution,
        fps,
        vcodec,
        acodec,
        filesize,
        protocol,
        previewUrl: sourceUrl ? `/api/voice/cosyvoice/preview-url?url=${encodeURIComponent(sourceUrl)}&formatId=${encodeURIComponent(formatId)}` : '',
    };
}

async function findDownloadedSourcePath(id: string): Promise<string> {
    const { uploadDir } = getCosyVoicePaths();
    const entries = await fs.readdir(uploadDir);
    const candidates = entries
        .filter(entry => entry.startsWith(`source-${id}.`))
        .map(entry => resolve(uploadDir, entry))
        .filter(path => isInsideDirectory(path, uploadDir));
    if (candidates.length === 0) {
        throw new Error('yt-dlp did not produce a downloadable audio file.');
    }
    return candidates[0]!;
}

function countPromptTextChars(value: string): number {
    return Array.from(value.replace(/\s+/g, '')).length;
}

function withTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`;
}

function normalizeLocalBaseUrl(value: string): string {
    const url = new URL(withTrailingSlash(value));
    if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1';
    }
    return url.toString();
}
