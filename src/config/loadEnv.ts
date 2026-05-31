import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const loadedEnvFiles = new Set<string>();
const fileLoadedEnvKeys = new Set<string>();

export function loadRuntimeEnv(): void {
  const environment = process.env.NODE_ENV || process.env.APP_ENV || 'development';
  const files = [
    '.env',
    `.env.${environment}`,
    `.env.${environment}.local`,
    '.env.local',
  ];

  for (const file of files) {
    loadEnvFile(file);
  }
}

function loadEnvFile(file: string): void {
  const path = resolve(file);
  if (loadedEnvFiles.has(path) || !existsSync(path)) {
    return;
  }
  loadedEnvFiles.add(path);

  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key || (process.env[key] !== undefined && !fileLoadedEnvKeys.has(key))) continue;

    process.env[key] = parseEnvValue(rawValue);
    fileLoadedEnvKeys.add(key);
  }
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
