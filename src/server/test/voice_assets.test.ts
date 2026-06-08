import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Voice Asset Foundation', () => {
  const originalVoiceDataRoot = process.env.VOICE_DATA_ROOT;
  const originalVoiceAssetRoot = process.env.VOICE_ASSET_ROOT;
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ha-voice-assets-'));
    process.env.VOICE_DATA_ROOT = join(tempRoot, 'data', 'voice');
    delete process.env.VOICE_ASSET_ROOT;
  });

  afterEach(() => {
    if (originalVoiceDataRoot === undefined) {
      delete process.env.VOICE_DATA_ROOT;
    } else {
      process.env.VOICE_DATA_ROOT = originalVoiceDataRoot;
    }
    if (originalVoiceAssetRoot === undefined) {
      delete process.env.VOICE_ASSET_ROOT;
    } else {
      process.env.VOICE_ASSET_ROOT = originalVoiceAssetRoot;
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('should create path convention and support asset CRUD', async () => {
    const {
      ensureVoiceAssetDirs,
      getVoiceAssetPaths,
      registerVoiceAssetFile,
      listVoiceAssets,
      getVoiceAsset,
      removeVoiceAsset,
    } = await import('@server/services/voice-assets');

    const paths = await ensureVoiceAssetDirs();
    const sourcePath = join(tempRoot, 'source.wav');
    writeFileSync(sourcePath, 'wav-data');

    expect(paths.rootDir).toContain(join('data', 'voice', 'assets'));
    const asset = await registerVoiceAssetFile({
      kind: 'speaker_prompt',
      sourcePath,
      targetName: 'prompt.wav',
      assetId: 'asset-1',
      metadata: { speakerId: 'spk1' },
    });

    expect(asset.path).toBe(join(getVoiceAssetPaths().promptsDir, 'prompt.wav'));
    expect(await getVoiceAsset('asset-1')).toEqual(asset);
    expect(await listVoiceAssets('speaker_prompt')).toHaveLength(1);
    expect(await removeVoiceAsset('asset-1')).toBe(true);
    expect(await listVoiceAssets()).toHaveLength(0);
  });

  test('should upsert minimal speaker profiles in JSON index', async () => {
    const {
      listVoiceSpeakerProfiles,
      upsertVoiceSpeakerProfile,
      removeVoiceSpeakerProfile,
      getVoiceAssetPaths,
    } = await import('@server/services/voice-assets');

    await upsertVoiceSpeakerProfile({
      speakerId: 'spk1',
      speakerName: 'Speaker One',
      promptList: ['prompt-1'],
      benchmarkResults: [],
      cachedResponses: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(await listVoiceSpeakerProfiles()).toHaveLength(1);
    await upsertVoiceSpeakerProfile({
      speakerId: 'spk1',
      speakerName: 'Speaker One Updated',
      promptList: ['prompt-2', 'prompt-1'],
      benchmarkResults: ['benchmark-1'],
      cachedResponses: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const index = JSON.parse(await readFile(getVoiceAssetPaths().indexPath, 'utf8'));
    expect(index.speakers[0].promptList).toEqual(['prompt-2', 'prompt-1']);
    expect(index.speakers[0].benchmarkResults).toEqual(['benchmark-1']);
    expect(await removeVoiceSpeakerProfile('spk1')).toBe(true);
    expect(await listVoiceSpeakerProfiles()).toHaveLength(0);
  });
});

describe('Voice Quality Scoring', () => {
  const originalVoiceDataRoot = process.env.VOICE_DATA_ROOT;
  const originalVoiceAssetRoot = process.env.VOICE_ASSET_ROOT;
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ha-voice-quality-'));
    process.env.VOICE_DATA_ROOT = join(tempRoot, 'data', 'voice');
    delete process.env.VOICE_ASSET_ROOT;
    await mkdir(join(process.env.VOICE_DATA_ROOT, 'assets', 'cache'), { recursive: true });
  });

  afterEach(() => {
    if (originalVoiceDataRoot === undefined) {
      delete process.env.VOICE_DATA_ROOT;
    } else {
      process.env.VOICE_DATA_ROOT = originalVoiceDataRoot;
    }
    if (originalVoiceAssetRoot === undefined) {
      delete process.env.VOICE_ASSET_ROOT;
    } else {
      process.env.VOICE_ASSET_ROOT = originalVoiceAssetRoot;
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  test('should score a valid wav prompt', async () => {
    const { scorePromptQuality } = await import('@server/services/voice-assets/quality');
    const wavPath = join(tempRoot, 'prompt.wav');
    writeFileSync(wavPath, createToneWav(16000, 12_000));

    const score = await scorePromptQuality(wavPath);

    expect(score.score).toBeGreaterThan(50);
    expect(score.duration).toBeCloseTo(12, 0);
    expect(score.speechRatio).toBeGreaterThan(0.5);
    expect(score.silenceRatio).toBeLessThan(0.5);
    expect(score.estimatedSnr).toBeGreaterThan(8);
  });
});

describe('MDX separation plugin config', () => {
  test('should prefer CoreML provider on Apple Silicon auto mode', async () => {
    const { resolveOnnxProviders } = await import('@server/services/voice-assets/MdxSeparationService');

    expect(resolveOnnxProviders('darwin', 'arm64')).toEqual(['CoreMLExecutionProvider', 'CPUExecutionProvider']);
  });

  test('should resolve model profiles', async () => {
    const { resolveSeparationModel } = await import('@server/services/voice-assets/MdxSeparationService');

    expect(resolveSeparationModel()).toBeTruthy();
  });
});

function createToneWav(sampleRate: number, durationMs: number): Buffer {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 220) * 9000);
    data.writeInt16LE(sample, index * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
