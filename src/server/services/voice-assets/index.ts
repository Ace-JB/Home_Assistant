import { existsSync, realpathSync } from 'fs';
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';
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

export type VoiceAssetCleanupOptions = {
  now?: number;
  separatedMaxAgeMs?: number;
  separatedMaxFiles?: number;
  pcmCacheMaxAgeMs?: number;
  removeTemporaryCandidateAssets?: boolean;
};

export type VoiceAssetCleanupResult = {
  removedStaleAssets: number;
  removedTemporaryCandidateAssets: number;
  removedSeparatedAssets: number;
  removedSeparatedFiles: number;
  removedPcmCacheFiles: number;
};

export async function cleanupVoiceAssets(options: VoiceAssetCleanupOptions = {}): Promise<VoiceAssetCleanupResult> {
  const now = options.now ?? Date.now();
  const separatedMaxAgeMs = options.separatedMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const separatedMaxFiles = Math.max(0, Math.floor(options.separatedMaxFiles ?? 20));
  const pcmCacheMaxAgeMs = options.pcmCacheMaxAgeMs ?? 10 * 60 * 1000;
  const paths = await ensureVoiceAssetDirs();
  const index = await readVoiceAssetIndex();
  const existingAssets: VoiceAsset[] = [];
  let removedStaleAssets = 0;
  let removedTemporaryCandidateAssets = 0;

  for (const asset of index.assets) {
    if (!existsSync(asset.path)) {
      removedStaleAssets += 1;
    } else if (options.removeTemporaryCandidateAssets && isTemporaryCandidateAsset(asset)) {
      removedTemporaryCandidateAssets += 1;
    } else {
      existingAssets.push(asset);
    }
  }

  const separatedAssets = await Promise.all(existingAssets
    .filter(asset => asset.kind === 'separated')
    .map(async asset => ({
      asset,
      mtimeMs: await stat(asset.path).then(item => item.mtimeMs).catch(() => 0),
    })));
  const newestSeparated = new Set(separatedAssets
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, separatedMaxFiles)
    .map(item => item.asset.id));
  const removeSeparated = new Set<string>();

  for (const item of separatedAssets) {
    const ageMs = Math.max(0, now - item.mtimeMs);
    if (!newestSeparated.has(item.asset.id) && ageMs > separatedMaxAgeMs) {
      removeSeparated.add(item.asset.id);
    }
  }

  let removedSeparatedFiles = 0;
  for (const asset of existingAssets) {
    if (!removeSeparated.has(asset.id)) continue;
    if (isInsideDirectory(asset.path, paths.separatedDir)) {
      await rm(asset.path, { force: true }).then(() => {
        removedSeparatedFiles += 1;
      }).catch(() => undefined);
    }
  }

  const nextAssets = existingAssets.filter(asset => !removeSeparated.has(asset.id));
  const removedPcmCacheFiles = await cleanupPcmCacheFiles(paths.cacheDir, now, pcmCacheMaxAgeMs);
  if (removedStaleAssets > 0 || removedTemporaryCandidateAssets > 0 || removeSeparated.size > 0) {
    await writeVoiceAssetIndex({ ...index, assets: nextAssets });
  }

  return {
    removedStaleAssets,
    removedTemporaryCandidateAssets,
    removedSeparatedAssets: removeSeparated.size,
    removedSeparatedFiles,
    removedPcmCacheFiles,
  };
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

function isInsideDirectory(path: string, root: string): boolean {
  const relativePath = relative(resolveForContainment(root), resolveForContainment(path));
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function resolveForContainment(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isTemporaryCandidateAsset(asset: VoiceAsset): boolean {
  return asset.kind === 'candidate' && resolve(asset.path).split(/[\\/]+/u).includes('material-jobs');
}

async function cleanupPcmCacheFiles(cacheDir: string, now: number, maxAgeMs: number): Promise<number> {
  const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.pcm')) continue;
    const filePath = join(cacheDir, entry.name);
    const stats = await stat(filePath).catch(() => null);
    if (!stats?.isFile()) continue;
    if (now - stats.mtimeMs <= maxAgeMs) continue;
    if (!isInsideDirectory(filePath, cacheDir)) continue;
    await rm(filePath, { force: true }).then(() => {
      removed += 1;
    }).catch(() => undefined);
  }
  return removed;
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
