import { mkdir } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { getVoiceAssetsDataRoot } from '@/server/services/voice-data-paths';
import type { VoiceAssetKind } from './types';

export type VoiceAssetPaths = {
  rootDir: string;
  indexPath: string;
  speakersDir: string;
  promptsDir: string;
  benchmarkDir: string;
  cacheDir: string;
  separatedDir: string;
  validationDir: string;
};

const KIND_DIRS: Record<VoiceAssetKind, keyof Pick<VoiceAssetPaths,
  'speakersDir' | 'promptsDir' | 'benchmarkDir' | 'cacheDir' | 'separatedDir' | 'validationDir'
>> = {
  speaker_prompt: 'promptsDir',
  separated: 'separatedDir',
  candidate: 'promptsDir',
  benchmark: 'benchmarkDir',
  cache: 'cacheDir',
  validation: 'validationDir',
};

export function getVoiceAssetPaths(): VoiceAssetPaths {
  const rootDir = getVoiceAssetsDataRoot();
  return {
    rootDir,
    indexPath: join(rootDir, 'index.json'),
    speakersDir: join(rootDir, 'speakers'),
    promptsDir: join(rootDir, 'prompts'),
    benchmarkDir: join(rootDir, 'benchmark'),
    cacheDir: join(rootDir, 'cache'),
    separatedDir: join(rootDir, 'separated'),
    validationDir: join(rootDir, 'validation'),
  };
}

export async function ensureVoiceAssetDirs(): Promise<VoiceAssetPaths> {
  const paths = getVoiceAssetPaths();
  await Promise.all([
    mkdir(paths.speakersDir, { recursive: true }),
    mkdir(paths.promptsDir, { recursive: true }),
    mkdir(paths.benchmarkDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.separatedDir, { recursive: true }),
    mkdir(paths.validationDir, { recursive: true }),
  ]);
  return paths;
}

export function getVoiceAssetKindDir(kind: VoiceAssetKind): string {
  const paths = getVoiceAssetPaths();
  return paths[KIND_DIRS[kind]];
}

export function isInsideVoiceAssets(path: string): boolean {
  const relativePath = relative(getVoiceAssetPaths().rootDir, resolve(path));
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

export function toVoiceAssetRelativePath(path: string): string {
  return relative(getVoiceAssetPaths().rootDir, resolve(path));
}
