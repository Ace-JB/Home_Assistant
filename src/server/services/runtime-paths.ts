import { join, resolve } from 'path';

export const DEFAULT_COSYVOICE_MODEL_DIR = join('data', 'python_services', 'models_cache', 'cosyvoice', 'Fun-CosyVoice3-0.5B-2512-4bit');

export function resolveRuntimePath(envKey: string, defaultPath: string): string {
    const configured = process.env[envKey];
    if (configured?.trim()) return resolve(configured);
    return resolve(defaultPath);
}

export function getDataDbDir(): string {
    return resolveRuntimePath('SENTINEL_DB_DIR', join('data', 'db'));
}

export function getModelBasePath(): string {
    return resolveRuntimePath('SENTINEL_MODEL_BASE_PATH', join('data', 'models', 'server-models'));
}

export function getPythonServicesRoot(): string {
    return resolveRuntimePath('PYTHON_SERVICES_ROOT', join('data', 'python_services'));
}

export function getPythonServicesScriptRoot(): string {
    return resolveRuntimePath('PYTHON_SERVICES_SCRIPT_ROOT', join('src', 'server', 'python_services'));
}

export function getCosyVoiceModelDir(): string {
    return resolveRuntimePath('COSYVOICE_MODEL_DIR', DEFAULT_COSYVOICE_MODEL_DIR);
}
