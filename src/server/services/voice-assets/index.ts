import { existsSync } from 'fs';
import { copyFile, readFile, writeFile } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { ensureVoiceAssetDirs, getVoiceAssetKindDir, getVoiceAssetPaths } from './paths';
import type { VoiceAsset, VoiceAssetIndex, VoiceAssetKind, VoiceSpeakerProfile } from './types';

export * from './paths';
export type * from './types';

const EMPTY_INDEX = (): VoiceAssetIndex => ({
  assets: [],
  speakers: [],
  updatedAt: new Date().toISOString(),
});

export async function readVoiceAssetIndex(): Promise<VoiceAssetIndex> {
  const { indexPath } = getVoiceAssetPaths();
  if (!existsSync(indexPath)) {
    return EMPTY_INDEX();
  }

  const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as Partial<VoiceAssetIndex>;
  return {
    assets: Array.isArray(parsed.assets) ? parsed.assets.filter(isVoiceAsset) : [],
    speakers: Array.isArray(parsed.speakers) ? parsed.speakers.filter(isVoiceSpeakerProfile) : [],
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

export async function writeVoiceAssetIndex(index: VoiceAssetIndex): Promise<void> {
  const paths = await ensureVoiceAssetDirs();
  await writeFile(paths.indexPath, `${JSON.stringify({
    ...index,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
}

export async function listVoiceAssets(kind?: VoiceAssetKind): Promise<VoiceAsset[]> {
  const index = await readVoiceAssetIndex();
  return kind ? index.assets.filter(asset => asset.kind === kind) : index.assets;
}

export async function getVoiceAsset(assetId: string): Promise<VoiceAsset | null> {
  const index = await readVoiceAssetIndex();
  return index.assets.find(asset => asset.id === assetId) ?? null;
}

export async function upsertVoiceAsset(asset: VoiceAsset): Promise<VoiceAsset> {
  const index = await readVoiceAssetIndex();
  const existingIndex = index.assets.findIndex(item => item.id === asset.id);
  if (existingIndex >= 0) {
    index.assets[existingIndex] = asset;
  } else {
    index.assets.push(asset);
  }
  await writeVoiceAssetIndex(index);
  return asset;
}

export async function removeVoiceAsset(assetId: string): Promise<boolean> {
  const index = await readVoiceAssetIndex();
  const nextAssets = index.assets.filter(asset => asset.id !== assetId);
  const removed = nextAssets.length !== index.assets.length;
  if (removed) {
    await writeVoiceAssetIndex({ ...index, assets: nextAssets });
  }
  return removed;
}

export async function listVoiceSpeakerProfiles(): Promise<VoiceSpeakerProfile[]> {
  return (await readVoiceAssetIndex()).speakers;
}

export async function upsertVoiceSpeakerProfile(profile: VoiceSpeakerProfile): Promise<VoiceSpeakerProfile> {
  const index = await readVoiceAssetIndex();
  const existingIndex = index.speakers.findIndex(item => item.speakerId === profile.speakerId);
  if (existingIndex >= 0) {
    index.speakers[existingIndex] = profile;
  } else {
    index.speakers.push(profile);
  }
  await writeVoiceAssetIndex(index);
  return profile;
}

export async function removeVoiceSpeakerProfile(speakerId: string): Promise<boolean> {
  const index = await readVoiceAssetIndex();
  const nextSpeakers = index.speakers.filter(speaker => speaker.speakerId !== speakerId);
  const removed = nextSpeakers.length !== index.speakers.length;
  if (removed) {
    await writeVoiceAssetIndex({ ...index, speakers: nextSpeakers });
  }
  return removed;
}

export async function registerVoiceAssetFile(input: {
  kind: VoiceAssetKind;
  sourcePath: string;
  targetName?: string;
  assetId?: string;
  copy?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<VoiceAsset> {
  await ensureVoiceAssetDirs();
  const id = input.assetId ?? createVoiceAssetId(input.kind);
  const targetPath = input.copy === false
    ? resolve(input.sourcePath)
    : resolve(getVoiceAssetKindDir(input.kind), input.targetName ?? `${id}-${basename(input.sourcePath)}`);

  if (input.copy !== false && resolve(input.sourcePath) !== targetPath) {
    await copyFile(input.sourcePath, targetPath);
  }

  return upsertVoiceAsset({
    id,
    kind: input.kind,
    path: targetPath,
    createdAt: new Date().toISOString(),
    metadata: input.metadata,
  });
}

export function createVoiceAssetId(kind: VoiceAssetKind): string {
  return `${kind}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function safeVoiceAssetName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    || 'voice-asset';
}

function isVoiceAsset(value: unknown): value is VoiceAsset {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && typeof item.kind === 'string'
    && typeof item.path === 'string'
    && typeof item.createdAt === 'string';
}

function isVoiceSpeakerProfile(value: unknown): value is VoiceSpeakerProfile {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.speakerId === 'string'
    && typeof item.speakerName === 'string'
    && Array.isArray(item.promptList)
    && Array.isArray(item.benchmarkResults)
    && Array.isArray(item.cachedResponses)
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}
