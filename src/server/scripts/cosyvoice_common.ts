import { existsSync, readFileSync } from 'fs';
import { chmod, copyFile, mkdir, rm, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

export type CosyVoicePaths = {
    installDir: string;
    toolDir: string;
    mambaRootPrefix: string;
    condaEnv: string;
    modelDir: string;
    mlxPackage: string;
    host: string;
    port: string;
};

const loadedEnvFiles = new Set<string>();
const fileLoadedEnvKeys = new Set<string>();

export function loadRuntimeEnvForScript(): void {
    const environment = process.env.NODE_ENV || process.env.APP_ENV || 'development';
    for (const file of ['.env', `.env.${environment}`, `.env.${environment}.local`, '.env.local']) {
        loadEnvFile(file);
    }
}

export function getCosyVoicePaths(): CosyVoicePaths {
    const baseUrl = new URL(process.env.COSYVOICE_BASE_URL || 'http://localhost:50000');
    return {
        installDir: resolve(process.env.COSYVOICE_INSTALL_DIR || 'src/server/models/voice/CosyVoice3-MLX'),
        toolDir: resolve('src/server/models/voice/tools'),
        mambaRootPrefix: resolve('src/server/models/voice/.micromamba'),
        condaEnv: process.env.COSYVOICE_CONDA_ENV || 'cosyvoice',
        modelDir: process.env.COSYVOICE_MODEL_DIR || 'mlx-community/Fun-CosyVoice3-0.5B-2512-4bit',
        mlxPackage: process.env.COSYVOICE_MLX_PACKAGE || 'mlx-audio-plus==0.1.8',
        host: baseUrl.hostname || 'localhost',
        port: baseUrl.port || '50000',
    };
}

export async function ensureParentDir(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
}

export function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
    return new Promise((resolveRun, reject) => {
        console.log(`[CosyVoiceSetup] run ${command} ${args.join(' ')}`);
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolveRun();
                return;
            }
            reject(new Error(`${command} failed code=${code}, signal=${signal}`));
        });
    });
}

export function commandExists(command: string): Promise<boolean> {
    return new Promise((resolveExists) => {
        const child = spawn(command, ['--version'], { stdio: 'ignore' });
        child.once('error', () => resolveExists(false));
        child.once('exit', code => resolveExists(code === 0));
    });
}

export async function getPythonEnvRunner(paths: CosyVoicePaths): Promise<{
    command: string;
    createArgs: (envPrefix: string) => string[];
    runArgs: (envPrefix: string, args: string[]) => string[];
    env: Record<string, string>;
}> {
    if (await commandExists('conda')) {
        return {
            command: 'conda',
            createArgs: (envPrefix) => ['create', '-y', '-p', envPrefix, 'python=3.10'],
            runArgs: (envPrefix, args) => ['run', '-p', envPrefix, ...args],
            env: {},
        };
    }

    const micromamba = await ensureMicromamba(paths);
    return {
        command: micromamba,
        createArgs: (envPrefix) => ['create', '-y', '-p', envPrefix, 'python=3.10', '-c', 'conda-forge'],
        runArgs: (envPrefix, args) => ['run', '-p', envPrefix, ...args],
        env: {
            MAMBA_ROOT_PREFIX: paths.mambaRootPrefix,
        },
    };
}

export function isCosyVoiceInstalled(installDir: string): boolean {
    return existsSync(resolve(installDir, '.conda'))
        && existsSync(resolve(installDir, '.cosyvoice-mlx-installed'));
}

async function ensureMicromamba(paths: CosyVoicePaths): Promise<string> {
    const targetPath = resolve(paths.toolDir, 'micromamba');
    if (existsSync(targetPath)) {
        return targetPath;
    }

    const platform = getMicromambaPlatform();
    const downloadUrl = `https://micro.mamba.pm/api/micromamba/${platform}/latest`;
    const archivePath = resolve(paths.toolDir, 'micromamba.tar.bz2');
    const extractDir = resolve(paths.toolDir, 'micromamba-extract');

    await mkdir(paths.toolDir, { recursive: true });
    console.log(`[CosyVoiceSetup] downloading micromamba ${downloadUrl}`);
    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`Failed to download micromamba: HTTP ${response.status}`);
    }
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));

    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await run('tar', ['-xjf', archivePath, '-C', extractDir]);
    await copyFile(resolve(extractDir, 'bin/micromamba'), targetPath);
    await chmod(targetPath, 0o755);
    await rm(extractDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });

    return targetPath;
}

function getMicromambaPlatform(): string {
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'osx-arm64';
    if (process.platform === 'darwin') return 'osx-64';
    if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-aarch64';
    if (process.platform === 'linux') return 'linux-64';
    throw new Error(`Unsupported platform for automatic micromamba install: ${process.platform}/${process.arch}`);
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
