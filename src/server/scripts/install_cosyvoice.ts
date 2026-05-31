import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
    ensureParentDir,
    getCosyVoicePaths,
    getPythonEnvRunner,
    loadRuntimeEnvForScript,
    run,
} from './cosyvoice_common';

loadRuntimeEnvForScript();

const paths = getCosyVoicePaths();
console.log(`[CosyVoiceSetup] installDir=${paths.installDir}`);
console.log('[CosyVoiceSetup] backend=mlx');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('CosyVoice MLX requires Apple Silicon macOS.');
}

const pythonEnv = await getPythonEnvRunner(paths);
await ensureParentDir(paths.installDir);
if (!existsSync(paths.installDir)) {
    await mkdir(paths.installDir, { recursive: true });
}

const envPrefix = resolve(paths.installDir, '.conda');
if (!existsSync(envPrefix)) {
    await run(pythonEnv.command, pythonEnv.createArgs(envPrefix), { env: pythonEnv.env });
} else {
    console.log(`[CosyVoiceSetup] MLX conda env already exists: ${envPrefix}`);
}

await run(pythonEnv.command, pythonEnv.runArgs(envPrefix, [
    'python',
    '-m', 'pip',
    'install',
    '--upgrade',
    'pip',
    'wheel',
    'setuptools',
]), { cwd: paths.installDir, env: pythonEnv.env });

await run(pythonEnv.command, pythonEnv.runArgs(envPrefix, [
    'python',
    '-m', 'pip',
    'install',
    'mlx>=0.25.2',
    'mlx-lm>=0.18.0,<0.30.0',
    'transformers>=4.49.0,<5.0.0',
    'huggingface_hub>=0.27.0',
    'hf_transfer',
    'numpy>=1.26.4',
    'librosa==0.11.0',
    'soundfile',
    'sounddevice>=0.5.1',
    'pyloudnorm>=0.1.1',
    'tqdm>=4.67.1',
    'einops>=0.8.1',
    'einx==0.3.0',
    'omegaconf==2.3.0',
    'dacite>=1.9.2',
    'loguru>=0.7.3',
    'num2words>=0.5.14',
    'misaki>=0.8.2',
    'phonemizer-fork>=3.3.2',
    'espeakng-loader>=0.2.4',
    'torch>=2.0.0',
    'fastapi',
    'uvicorn',
    'python-multipart',
]), { cwd: paths.installDir, env: pythonEnv.env });

await run(pythonEnv.command, pythonEnv.runArgs(envPrefix, [
    'python',
    '-m', 'pip',
    'install',
    '--no-deps',
    paths.mlxPackage,
]), { cwd: paths.installDir, env: pythonEnv.env });

await writeFile(resolve(paths.installDir, '.cosyvoice-mlx-installed'), [
    'backend=mlx',
    `model=${paths.modelDir}`,
    `package=${paths.mlxPackage}`,
    '',
].join('\n'), 'utf8');
console.log('[CosyVoiceSetup] MLX install complete.');
console.log(`[CosyVoiceSetup] start with: bun run cosyvoice:start`);
