import { existsSync } from 'fs';
import { resolve } from 'path';
import { createServer } from 'net';
import {
    getCosyVoicePaths,
    isCosyVoiceInstalled,
    loadRuntimeEnvForScript,
    run,
} from './cosyvoice_common';

loadRuntimeEnvForScript();

const paths = getCosyVoicePaths();
const envPrefix = resolve(paths.installDir, '.conda');
const serverPath = resolve('src/server/scripts/cosyvoice_mlx_fastapi_server.py');

if (!isCosyVoiceInstalled(paths.installDir)) {
    throw new Error(`CosyVoice is not installed at ${paths.installDir}. Run: bun run cosyvoice:install`);
}
if (!existsSync(envPrefix)) {
    throw new Error(`CosyVoice MLX env is missing at ${envPrefix}. Run: bun run cosyvoice:install`);
}
if (!existsSync(serverPath)) {
    throw new Error(`CosyVoice FastAPI wrapper was not found: ${serverPath}`);
}

const health = await checkExistingService(paths.host, paths.port);
if (health.ok) {
    console.log(`[CosyVoiceSetup] existing CosyVoice service is healthy at ${health.url}`);
    process.exit(0);
}

const portAvailable = await isPortAvailable(Number(paths.port));
if (!portAvailable) {
    throw new Error(`Port ${paths.port} is already in use, but CosyVoice health check failed at ${health.url}. Stop the stale process or set COSYVOICE_BASE_URL to another free port.`);
}

console.log(`[CosyVoiceSetup] starting CosyVoice at http://${paths.host}:${paths.port}`);
console.log('[CosyVoiceSetup] backend=mlx');
console.log(`[CosyVoiceSetup] modelDir=${paths.modelDir}`);

const args = [
    'python',
    serverPath,
    '--port', paths.port,
    '--model_dir', paths.modelDir,
    '--cache_dir', resolve('data/cosyvoice/mlx-speaker-cache'),
];

const command = resolve(envPrefix, 'bin/python');
const commandArgs = args.slice(1);

await run(command, commandArgs, {
    cwd: paths.installDir,
});

async function checkExistingService(host: string, port: string): Promise<{ ok: boolean; url: string }> {
    const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const url = `http://${probeHost}:${port}/health`;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) {
            return { ok: false, url };
        }
        const body = await response.json().catch(() => null) as { backend?: unknown; ok?: unknown } | null;
        return { ok: body?.backend === 'mlx' || body?.ok === true, url };
    } catch {
        return { ok: false, url };
    }
}

function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolveAvailable) => {
        const server = createServer();
        server.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                resolveAvailable(false);
                return;
            }
            console.warn(`[CosyVoiceSetup] port probe skipped: ${error.code ?? error.message}`);
            resolveAvailable(true);
        });
        server.once('listening', () => {
            server.close(() => resolveAvailable(true));
        });
        server.listen(port, '0.0.0.0');
    });
}
