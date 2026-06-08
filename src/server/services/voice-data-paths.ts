import { existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';

export function getVoiceDataRoot(): string {
  return canonicalizeExistingPath(resolve(process.env.VOICE_DATA_ROOT ?? 'data/voice'));
}

export function getCosyVoiceDataRoot(): string {
  return canonicalizeExistingPath(resolve(process.env.COSYVOICE_DATA_ROOT ?? join(getVoiceDataRoot(), 'cosyvoice')));
}

export function getVoiceAssetsDataRoot(): string {
  return canonicalizeExistingPath(resolve(process.env.VOICE_ASSET_ROOT ?? join(getVoiceDataRoot(), 'assets')));
}

function canonicalizeExistingPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}
