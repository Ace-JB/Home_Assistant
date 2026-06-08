import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, stat } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';
import { GLOBAL_CONFIG } from '@/global_config';
import { createVoiceAssetId, ensureVoiceAssetDirs, registerVoiceAssetFile, safeVoiceAssetName } from './index';

export type SeparationServiceStatus = 'disabled' | 'stopped' | 'starting' | 'ready' | 'busy' | 'error';
export type VoiceSeparationReason = 'prompt-import' | 'asr-utterance';

export type VoiceSeparationRequest = {
  inputPath: string;
  reason: VoiceSeparationReason;
  requireService?: boolean;
};

export type VoiceSeparationResult = {
  inputPath: string;
  outputPath: string;
  provider: 'mdx-net' | 'none';
  model?: string;
  onnxProviders?: string[];
  method: 'mdx-net-onnx' | 'current-flow';
  serviceStarted: boolean;
  cacheHit: boolean;
  durationMs: number;
  fallbackUsed: boolean;
};

type ServiceHealth = {
  ok?: boolean;
  ready?: boolean;
  busy?: boolean;
  pid?: number | null;
  startedAt?: number | null;
  uptimeSeconds?: number | null;
  model?: string;
  onnxProviders?: string[];
  queueLength?: number;
  lastError?: string | null;
};

type SeparationResponse = {
  ok?: boolean;
  outputPath?: string;
  model?: string;
  onnxProviders?: string[];
  durationMs?: number;
  error?: string;
};

const execFileAsync = promisify(execFile);

export class MdxSeparationService {
  private status: SeparationServiceStatus = GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED ? 'stopped' : 'disabled';
  private startPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private startedAt = 0;
  private pid: number | null = null;
  private model = resolveSeparationModel();
  private providers = resolveOnnxProviders();
  private queueLength = 0;
  private logs: Array<{ ts: number; level: 'info' | 'warn' | 'error'; message: string }> = [];

  async separate(input: VoiceSeparationRequest): Promise<VoiceSeparationResult> {
    const startedAt = Date.now();
    const paths = await ensureVoiceAssetDirs();
    const inputPath = resolve(input.inputPath);
    const inputStat = await stat(inputPath);
    const cacheKey = `${basename(inputPath)}-${inputStat.size}-${Math.round(inputStat.mtimeMs)}-${this.model}`;
    const outputPath = join(paths.separatedDir, `${safeVoiceAssetName(cacheKey)}-vocals.wav`);
    if (existsSync(outputPath)) {
      return this.recordResult({
        inputPath,
        outputPath,
        method: 'mdx-net-onnx',
        provider: 'mdx-net',
        serviceStarted: false,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
        fallbackUsed: false,
      }, cacheKey, input.reason);
    }

    const canUseService = GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED
      && (input.reason === 'prompt-import' || this.isReady());
    if (!canUseService) {
      return this.handleUnavailable(input, inputPath, outputPath, cacheKey, startedAt);
    }

    const serviceStarted = !this.isReady();
    try {
      if (input.reason === 'prompt-import' || input.requireService) {
        await this.start();
      } else if (!this.isReady()) {
        return this.handleUnavailable(input, inputPath, outputPath, cacheKey, startedAt);
      }

      await mkdir(dirname(outputPath), { recursive: true });
      const response = await this.postJson('/separate', { inputPath, outputPath }) as SeparationResponse;
      if (!response.ok || !response.outputPath) {
        throw new Error(response.error || 'MDX-Net service failed.');
      }
      return this.recordResult({
        inputPath,
        outputPath: response.outputPath,
        provider: 'mdx-net',
        model: response.model ?? this.model,
        onnxProviders: response.onnxProviders ?? this.providers,
        method: 'mdx-net-onnx',
        serviceStarted,
        cacheHit: false,
        durationMs: Date.now() - startedAt,
        fallbackUsed: false,
      }, cacheKey, input.reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.status = this.status === 'disabled' ? 'disabled' : 'error';
      this.appendLog('error', message);
      if (!GLOBAL_CONFIG.VOICE.SEPARATION_ALLOW_FALLBACK && input.requireService) {
        throw error;
      }
      return this.handleUnavailable(input, inputPath, outputPath, cacheKey, startedAt, message);
    }
  }

  async start(): Promise<void> {
    if (!GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED) {
      this.status = 'disabled';
      throw new Error('Voice separation is disabled.');
    }
    const current = await this.refreshStatus().catch(() => null);
    if (current?.ready) return;
    if (this.startPromise) return this.startPromise;

    this.status = 'starting';
    this.appendLog('info', `Starting MDX-Net HTTP service model=${this.model}`);
    this.startPromise = (async () => {
      await runPythonServiceManager(['start', 'mdx']);
      await this.postJson('/start', {});
      await this.waitUntilReady();
    })().catch(error => {
      this.status = 'error';
      this.lastError = getErrorMessage(error);
      this.appendLog('error', this.lastError);
      throw error;
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    await this.postJson('/stop', {}).catch(() => undefined);
    await runPythonServiceManager(['stop', 'mdx']).catch(error => {
      this.appendLog('warn', getErrorMessage(error));
    });
    this.status = GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED ? 'stopped' : 'disabled';
    this.startedAt = 0;
    this.pid = null;
  }

  getStatus() {
    void this.refreshStatus().catch(() => undefined);
    return {
      status: GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED ? this.status : 'disabled' as SeparationServiceStatus,
      ready: this.isReady(),
      pid: this.pid,
      startedAt: this.startedAt || null,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
      model: this.model,
      onnxProviders: this.providers,
      queueLength: this.queueLength,
      lastError: this.lastError,
      enabled: GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED,
      url: serviceUrl(),
    };
  }

  getLogs(limit = 200) {
    return this.logs.slice(-Math.max(1, Math.min(limit, 500)));
  }

  isReady(): boolean {
    return this.status === 'ready' || this.status === 'busy';
  }

  private async waitUntilReady(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      const health = await this.refreshStatus().catch(() => null);
      if (health?.ready) return;
      await Bun.sleep(1000);
    }
    throw new Error('MDX-Net HTTP service startup timeout (60s)');
  }

  private async refreshStatus(): Promise<ServiceHealth> {
    if (!GLOBAL_CONFIG.VOICE.SEPARATION_ENABLED) {
      this.status = 'disabled';
      return { ready: false };
    }
    const response = await fetch(new URL('/health', serviceUrl()), {
      signal: AbortSignal.timeout(1500),
    });
    const health = await response.json() as ServiceHealth;
    this.status = !response.ok
      ? 'error'
      : health.busy
        ? 'busy'
        : health.ready || health.ok
          ? 'ready'
          : 'stopped';
    this.pid = health.pid ?? null;
    this.startedAt = health.startedAt ?? this.startedAt;
    this.model = health.model ?? this.model;
    this.providers = health.onnxProviders ?? this.providers;
    this.queueLength = health.queueLength ?? 0;
    this.lastError = response.ok ? health.lastError ?? null : `HTTP ${response.status}`;
    return health;
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, serviceUrl()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    }).catch(error => {
      throw new Error(`MDX-Net service is unreachable at ${serviceUrl()}: ${getErrorMessage(error)}`);
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`MDX-Net request failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
    }
    const parsed = await response.json() as Record<string, unknown>;
    await this.refreshStatus().catch(() => undefined);
    return parsed;
  }

  private async handleUnavailable(
    request: VoiceSeparationRequest,
    inputPath: string,
    outputPath: string,
    cacheKey: string,
    startedAt: number,
    reason = 'service unavailable',
  ): Promise<VoiceSeparationResult> {
    if (request.requireService && !GLOBAL_CONFIG.VOICE.SEPARATION_ALLOW_FALLBACK) {
      throw new Error(`Voice separation service is unavailable: ${reason}`);
    }
    await extractMonoVoiceReadyWav(inputPath, outputPath);
    return this.recordResult({
      inputPath,
      outputPath,
      provider: 'none',
      method: 'current-flow',
      serviceStarted: false,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      fallbackUsed: true,
    }, cacheKey, request.reason);
  }

  private async recordResult(
    result: VoiceSeparationResult,
    cacheKey: string,
    reason: VoiceSeparationReason,
  ): Promise<VoiceSeparationResult> {
    await registerVoiceAssetFile({
      kind: 'separated',
      sourcePath: result.outputPath,
      copy: false,
      assetId: createVoiceAssetId('separated'),
      metadata: {
        sourcePath: result.inputPath,
        method: result.method,
        provider: result.provider,
        model: result.model,
        onnxProviders: result.onnxProviders,
        cacheKey,
        reason,
        cacheHit: result.cacheHit,
        fallbackUsed: result.fallbackUsed,
        durationMs: result.durationMs,
      },
    });
    return result;
  }

  private appendLog(level: 'info' | 'warn' | 'error', message: string): void {
    this.logs.push({ ts: Date.now(), level, message });
    if (this.logs.length > 500) {
      this.logs.splice(0, this.logs.length - 500);
    }
  }
}

export const mdxSeparationService = new MdxSeparationService();

export function resolveSeparationModel(): string {
  if (GLOBAL_CONFIG.VOICE.SEPARATION_MODEL.trim()) {
    return GLOBAL_CONFIG.VOICE.SEPARATION_MODEL.trim();
  }
  const profile = GLOBAL_CONFIG.VOICE.SEPARATION_MODEL_PROFILE;
  if (profile === 'fast') return 'UVR-MDX-NET-Inst_Main.onnx';
  if (profile === 'quality') return 'Kim_Vocal_2.onnx';
  return 'UVR-MDX-NET-Inst_HQ_3.onnx';
}

export function resolveOnnxProviders(platform = process.platform, arch = process.arch): string[] {
  const explicit = GLOBAL_CONFIG.VOICE.SEPARATION_ONNX_PROVIDERS
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (GLOBAL_CONFIG.VOICE.SEPARATION_DEVICE === 'cpu') {
    return ['CPUExecutionProvider'];
  }
  if (explicit.length > 0) {
    return explicit;
  }
  return platform === 'darwin' && arch === 'arm64'
    ? ['CoreMLExecutionProvider', 'CPUExecutionProvider']
    : ['CPUExecutionProvider'];
}

async function extractMonoVoiceReadyWav(inputPath: string, outputPath: string): Promise<void> {
  const { spawn } = await import('child_process');
  await mkdir(dirname(outputPath), { recursive: true });
  await new Promise<void>((resolveProcess, reject) => {
    const child = spawn(GLOBAL_CONFIG.FFMPEG.BIN, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vn',
      '-af', 'highpass=f=80,lowpass=f=7600,dynaudnorm=f=150:g=15',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      reject(new Error(`ffmpeg failed code=${code}, signal=${signal}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
  });
}

async function runPythonServiceManager(args: string[]): Promise<void> {
  await execFileAsync(`${GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_SCRIPT_ROOT}/bin/manage`, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHON_SERVICES_ROOT: GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_ROOT,
      PYTHON_SERVICES_DEVICE: GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_DEVICE,
      MDX_PORT: String(GLOBAL_CONFIG.VOICE.MDX_PORT),
      VOICE_SEPARATION_MODEL_DIR: GLOBAL_CONFIG.VOICE.SEPARATION_MODEL_DIR,
      VOICE_SEPARATION_MODEL: GLOBAL_CONFIG.VOICE.SEPARATION_MODEL,
      VOICE_SEPARATION_DEVICE: GLOBAL_CONFIG.VOICE.SEPARATION_DEVICE,
      VOICE_SEPARATION_ONNX_PROVIDERS: GLOBAL_CONFIG.VOICE.SEPARATION_ONNX_PROVIDERS,
    },
    timeout: 90_000,
  });
}

function serviceUrl(): string {
  return GLOBAL_CONFIG.VOICE.SEPARATION_BASE_URL;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
