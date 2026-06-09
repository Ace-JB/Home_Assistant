import { spawn } from 'child_process';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { GLOBAL_CONFIG } from '@/global_config';
import { funasrService } from '@/server/services/FunASRService';
import { normalizeTranscript } from '@tools/Voice';
import {
  createVoiceAssetId,
  ensureVoiceAssetDirs,
  getVoiceAssetPaths,
  registerVoiceAssetFile,
  safeVoiceAssetName,
  upsertVoiceAsset,
} from './index';
import { mdxSeparationService, type VoiceSeparationRequest, type VoiceSeparationResult } from './MdxSeparationService';

export type PromptQualityScore = {
  score: number;
  duration: number;
  speechRatio: number;
  silenceRatio: number;
  rmsStability: number;
  pitchStability: number;
  energyStability: number;
  estimatedSnr: number;
  emotionStability: number;
};

export type PromptCandidateExtraction = {
  id: string;
  audioPath: string;
  text: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  quality: PromptQualityScore;
};

export type QualityValidationResult = {
  speakerId: string;
  baselinePath: string;
  separatedPath: string;
  bestPromptPath: string;
  notesPath: string;
};

const MIN_PROMPT_MS = 10_000;
const MAX_PROMPT_MS = 30_000;
const BENCHMARK_TEXTS = [
  '你好，我是您的智能管家。',
  '请问有什么需要帮助的吗？',
  '今天天气不错。',
];

export async function separateVoice(input: string | VoiceSeparationRequest): Promise<VoiceSeparationResult> {
  const request = typeof input === 'string'
    ? { inputPath: input, reason: 'prompt-import' as const, requireService: true }
    : input;
  return mdxSeparationService.separate(request);
}

export async function separateVoiceFile(inputFile: string): Promise<string> {
  return (await separateVoice(inputFile)).outputPath;
}

export async function extractPromptCandidates(inputFile: string, options: {
  speakerId?: string;
  jobId?: string;
  maxCandidates?: number;
} = {}): Promise<PromptCandidateExtraction[]> {
  const paths = await ensureVoiceAssetDirs();
  const sourcePath = resolve(inputFile);
  const analysis = await funasrService.analyzeMaterial(sourcePath);
  const jobId = options.jobId ?? `quality-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const targetDir = join(paths.promptsDir, jobId);
  await mkdir(targetDir, { recursive: true });

  const candidates: PromptCandidateExtraction[] = [];
  const accepted = analysis.segments
    .map(segment => ({
      startMs: Math.max(0, Math.round(segment.start_ms)),
      endMs: Math.max(0, Math.round(segment.end_ms)),
      text: normalizeTranscript(segment.text),
      speaker: segment.spk || 'SPK0',
    }))
    .filter(segment => {
      const durationMs = segment.endMs - segment.startMs;
      return durationMs >= MIN_PROMPT_MS
        && durationMs <= MAX_PROMPT_MS
        && segment.text.replace(/\s+/g, '').length >= 8;
    })
    .slice(0, options.maxCandidates ?? 8);

  for (const [index, segment] of accepted.entries()) {
    const id = `candidate_${String(index + 1).padStart(2, '0')}`;
    const audioPath = join(targetDir, `${id}.wav`);
    await cutWav(sourcePath, audioPath, segment.startMs, segment.endMs);
    const quality = await scorePromptQuality(audioPath);
    const candidate: PromptCandidateExtraction = {
      id,
      audioPath,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      durationMs: segment.endMs - segment.startMs,
      quality,
    };
    candidates.push(candidate);
    await upsertVoiceAsset({
      id: createVoiceAssetId('candidate'),
      kind: 'candidate',
      path: audioPath,
      createdAt: new Date().toISOString(),
      metadata: {
        speakerId: options.speakerId,
        sourcePath,
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
        durationMs: candidate.durationMs,
        ...quality,
      },
    });
  }

  await writeFile(join(targetDir, 'candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`, 'utf8');
  return candidates.sort((left, right) => right.quality.score - left.quality.score);
}

export async function scorePromptQuality(audioPath: string): Promise<PromptQualityScore> {
  const stats = await analyzePcmStats(audioPath);
  const duration = stats.durationMs / 1000;
  const durationScore = scoreRange(stats.durationMs, MIN_PROMPT_MS, MAX_PROMPT_MS, 18_000);
  const speechScore = clamp01(stats.speechRatio / 0.82);
  const silenceScore = clamp01(1 - stats.silenceRatio / 0.28);
  const rmsStability = clamp01(1 - stats.rmsStdDev / Math.max(stats.rmsMean, 0.001));
  const energyStability = clamp01(1 - stats.energyStdDev / Math.max(stats.energyMean, 0.001));
  const estimatedSnr = Math.round(20 * Math.log10(Math.max(stats.activeRms, 0.001) / Math.max(stats.noiseRms, 0.001)));
  const snrScore = clamp01((estimatedSnr - 8) / 18);
  const pitchStability = clamp01(0.78 + rmsStability * 0.18);
  const emotionStability = clamp01((rmsStability + energyStability) / 2);
  const score = Math.round(100 * (
    durationScore * 0.18
    + speechScore * 0.18
    + silenceScore * 0.16
    + rmsStability * 0.16
    + energyStability * 0.12
    + snrScore * 0.12
    + pitchStability * 0.04
    + emotionStability * 0.04
  ));

  return {
    score,
    duration: Number(duration.toFixed(2)),
    speechRatio: Number(stats.speechRatio.toFixed(3)),
    silenceRatio: Number(stats.silenceRatio.toFixed(3)),
    rmsStability: Math.round(rmsStability * 100),
    pitchStability: Math.round(pitchStability * 100),
    energyStability: Math.round(energyStability * 100),
    estimatedSnr,
    emotionStability: Math.round(emotionStability * 100),
  };
}

export async function createPromptBenchmark(input: {
  speakerId: string;
  promptAudioPath: string;
  promptText: string;
  outputDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const paths = await ensureVoiceAssetDirs();
  const outputDir = input.outputDir ?? join(paths.benchmarkDir, safeVoiceAssetName(input.speakerId));
  await mkdir(outputDir, { recursive: true });

  const outputs: string[] = [];
  for (const [index, text] of BENCHMARK_TEXTS.entries()) {
    const audioPath = join(outputDir, `benchmark_${String(index + 1).padStart(2, '0')}.wav`);
    const audio = await requestCosyVoiceBenchmarkAudio(text, input.promptAudioPath, input.promptText, input.fetchImpl ?? fetch);
    await writeFile(audioPath, ensureWavAudio(Buffer.from(audio), GLOBAL_CONFIG.VOICE.COSYVOICE_SAMPLE_RATE));
    outputs.push(audioPath);
    await registerVoiceAssetFile({
      kind: 'benchmark',
      sourcePath: audioPath,
      copy: false,
      metadata: {
        speakerId: input.speakerId,
        promptAudioPath: input.promptAudioPath,
        text,
      },
    });
  }

  return outputs;
}

export async function validateVoiceQuality(input: {
  speakerId: string;
  baselinePromptPath: string;
  separatedPromptPath: string;
  bestPromptPath: string;
  promptText: string;
  fetchImpl?: typeof fetch;
}): Promise<QualityValidationResult> {
  const paths = await ensureVoiceAssetDirs();
  const outputDir = join(paths.validationDir, safeVoiceAssetName(input.speakerId));
  await mkdir(outputDir, { recursive: true });

  const baselinePath = await writeValidationSample('baseline', input.baselinePromptPath, input.promptText, outputDir, input.fetchImpl);
  const separatedPath = await writeValidationSample('separated', input.separatedPromptPath, input.promptText, outputDir, input.fetchImpl);
  const bestPromptPath = await writeValidationSample('best_prompt', input.bestPromptPath, input.promptText, outputDir, input.fetchImpl);
  const notesPath = join(outputDir, 'notes.json');
  const notes = {
    speakerId: input.speakerId,
    baselinePath,
    separatedPath,
    bestPromptPath,
    baselineScore: await scorePromptQuality(input.baselinePromptPath).then(item => item.score).catch(() => null),
    separatedScore: await scorePromptQuality(input.separatedPromptPath).then(item => item.score).catch(() => null),
    bestPromptScore: await scorePromptQuality(input.bestPromptPath).then(item => item.score).catch(() => null),
    successMetrics: [
      'Prompt Quality Score should correlate with manual listening.',
      'Separated prompt should outperform original Youtube/Bilibili prompt.',
      'Around-50-character text should be more stable than the current flow.',
      'Repeated generations for the same speaker should be more consistent.',
      'Manual rating should improve: more similar, stable, and natural.',
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(notesPath, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
  await registerVoiceAssetFile({
    kind: 'validation',
    sourcePath: notesPath,
    copy: false,
    metadata: notes,
  });

  return {
    speakerId: input.speakerId,
    baselinePath,
    separatedPath,
    bestPromptPath,
    notesPath,
  };
}

async function writeValidationSample(
  name: string,
  promptAudioPath: string,
  promptText: string,
  outputDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const targetPath = join(outputDir, `${name}.wav`);
  const text = '你好，我是您的智能管家。今天我会用稳定自然的声音为您服务，请问有什么需要帮助的吗？';
  const audio = await requestCosyVoiceBenchmarkAudio(text, promptAudioPath, promptText, fetchImpl);
  await writeFile(targetPath, ensureWavAudio(Buffer.from(audio), GLOBAL_CONFIG.VOICE.COSYVOICE_SAMPLE_RATE));
  return targetPath;
}

async function requestCosyVoiceBenchmarkAudio(
  text: string,
  promptAudioPath: string,
  promptText: string,
  fetchImpl: typeof fetch,
): Promise<ArrayBuffer> {
  const form = new FormData();
  form.set('tts_text', text);
  form.set('prompt_text', promptText);
  form.set('prompt_wav', Bun.file(resolve(promptAudioPath)));
  const url = new URL(GLOBAL_CONFIG.VOICE.COSYVOICE_ENDPOINT, withTrailingSlash(GLOBAL_CONFIG.VOICE.COSYVOICE_BASE_URL));
  const response = await fetchImpl(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(GLOBAL_CONFIG.VOICE.COSYVOICE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`CosyVoice benchmark failed status=${response.status}${detail ? ` detail=${detail.slice(0, 200)}` : ''}`);
  }
  return response.arrayBuffer();
}

async function cutWav(inputPath: string, outputPath: string, startMs: number, endMs: number): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await runProcess(GLOBAL_CONFIG.FFMPEG.BIN, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', (startMs / 1000).toFixed(3),
    '-t', Math.max(0.1, (endMs - startMs) / 1000).toFixed(3),
    '-i', inputPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputPath,
  ]);
}

async function analyzePcmStats(audioPath: string): Promise<{
  durationMs: number;
  speechRatio: number;
  silenceRatio: number;
  rmsMean: number;
  rmsStdDev: number;
  energyMean: number;
  energyStdDev: number;
  activeRms: number;
  noiseRms: number;
}> {
  const pcmPath = join(getVoiceAssetPaths().cacheDir, `${safeVoiceAssetName(basename(audioPath))}-${Date.now().toString(36)}.pcm`);
  await ensureVoiceAssetDirs();
  let pcm: Buffer;
  try {
    await runProcess(GLOBAL_CONFIG.FFMPEG.BIN, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', audioPath,
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      pcmPath,
    ]);
    pcm = await readFile(pcmPath);
  } finally {
    await rm(pcmPath, { force: true }).catch(() => undefined);
  }
  const frameSamples = 1600;
  const frameRms: number[] = [];
  for (let offset = 0; offset + 1 < pcm.length; offset += frameSamples * 2) {
    let sumSquares = 0;
    let samples = 0;
    const end = Math.min(pcm.length, offset + frameSamples * 2);
    for (let index = offset; index + 1 < end; index += 2) {
      const value = pcm.readInt16LE(index) / 32768;
      sumSquares += value * value;
      samples += 1;
    }
    if (samples > 0) {
      frameRms.push(Math.sqrt(sumSquares / samples));
    }
  }
  const durationMs = pcm.length / 2 / 16000 * 1000;
  const activeFrames = frameRms.filter(value => value >= 0.012);
  const noiseFrames = frameRms.filter(value => value < 0.012);
  return {
    durationMs,
    speechRatio: frameRms.length ? activeFrames.length / frameRms.length : 0,
    silenceRatio: frameRms.length ? noiseFrames.length / frameRms.length : 1,
    rmsMean: mean(frameRms),
    rmsStdDev: stdDev(frameRms),
    energyMean: mean(frameRms.map(value => value * value)),
    energyStdDev: stdDev(frameRms.map(value => value * value)),
    activeRms: mean(activeFrames),
    noiseRms: mean(noiseFrames),
  };
}

function ensureWavAudio(audio: Buffer, sampleRate: number): Buffer {
  if (audio.length >= 12 && audio.subarray(0, 4).toString('ascii') === 'RIFF' && audio.subarray(8, 12).toString('ascii') === 'WAVE') {
    return audio;
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

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      reject(new Error(`${command} failed code=${code}, signal=${signal}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
  });
}

function scoreRange(value: number, min: number, max: number, ideal: number): number {
  if (value < min || value > max) return 0;
  return clamp01(1 - Math.abs(value - ideal) / Math.max(ideal - min, max - ideal));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdDev(values: number[]): number {
  const avg = mean(values);
  return values.length ? Math.sqrt(mean(values.map(value => (value - avg) ** 2))) : 0;
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
