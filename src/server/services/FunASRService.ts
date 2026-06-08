import { execFile } from 'child_process';
import { promisify } from 'util';
import { GLOBAL_CONFIG } from '@/global_config';
import { pipelineLogs } from '@/server/services/PipelineLogService';

export type FunASRMaterialSegment = {
    start_ms: number;
    end_ms: number;
    text: string;
    spk: string;
    confidence?: number | null;
};

export type FunASRMaterialAnalysis = {
    text: string;
    segments: FunASRMaterialSegment[];
    raw?: unknown;
};

type FunASRHealth = {
    ok?: boolean;
    ready?: boolean;
    pid?: number | null;
    startedAt?: number | null;
    uptimeSeconds?: number | null;
    queueLength?: number;
    lastError?: string | null;
    model?: string;
};

const execFileAsync = promisify(execFile);

/**
 * HTTP client for the isolated FunASR FastAPI service.
 */
export class FunASRService {
    private static instance: FunASRService;
    private startPromise: Promise<void> | null = null;
    private status: FunASRHealth = { ready: false, pid: null, lastError: null };
    private logs: Array<{ ts: number; level: 'info' | 'warn' | 'error'; message: string }> = [];
    private lastReadyLogAt = 0;
    private readyConsolePrinted = false;

    private constructor() {}

    public static getInstance(): FunASRService {
        if (!FunASRService.instance) {
            FunASRService.instance = new FunASRService();
        }
        return FunASRService.instance;
    }

    async start() {
        const current = await this.refreshStatus().catch(() => null);
        if (current?.ready) {
            this.recordReady('already_ready', 0);
            return;
        }
        if (this.startPromise) return this.startPromise;

        this.startPromise = (async () => {
            const startedAt = Date.now();
            this.appendLog('info', 'Starting FunASR HTTP service...');
            try {
                await runPythonServiceManager(['start', 'funasr']);
                await this.postJson('/start', {});
                await this.waitUntilReady();
                const durationMs = Date.now() - startedAt;
                this.recordReady('started', durationMs);
            } catch (error) {
                const durationMs = Date.now() - startedAt;
                pipelineLogs.append({
                    category: 'dashboard-service',
                    level: 'error',
                    title: 'service.start',
                    message: getErrorMessage(error),
                    timings: [{ key: 'service_start', label: 'FunASR 启动', durationMs, detail: getErrorMessage(error) }],
                    metadata: {
                        serviceId: 'funasr',
                        ready: false,
                        durationMs,
                        url: serviceUrl(),
                        error: getErrorMessage(error),
                    },
                    pipelineId: 'funasr',
                });
                throw error;
            }
        })().catch(error => {
            const message = getErrorMessage(error);
            this.status = { ...this.status, ready: false, lastError: message };
            this.appendLog('error', message);
            throw error;
        }).finally(() => {
            this.startPromise = null;
        });

        return this.startPromise;
    }

    async transcribe(wavPath: string): Promise<string> {
        await this.start();
        const response = await this.postJson('/transcribe', { wavPath });
        return typeof response.text === 'string' ? response.text : '';
    }

    async analyzeMaterial(wavPath: string): Promise<FunASRMaterialAnalysis> {
        await this.start();
        const response = await this.postJson('/analyze-material', { wavPath });
        return normalizeAnalysis(response);
    }

    async stop() {
        this.appendLog('info', 'Stopping FunASR HTTP service...');
        await this.postJson('/stop', {}).catch(() => undefined);
        await runPythonServiceManager(['stop', 'funasr']).catch(error => {
            this.appendLog('warn', getErrorMessage(error));
        });
        this.status = { ready: false, pid: null, startedAt: null, uptimeSeconds: null, queueLength: 0, lastError: null };
    }

    getStatus() {
        void this.refreshStatus().catch(() => undefined);
        return {
            ready: Boolean(this.status.ready),
            starting: this.startPromise !== null && !this.status.ready,
            pid: this.status.pid ?? null,
            startedAt: this.status.startedAt ?? null,
            uptimeSeconds: this.status.uptimeSeconds ?? null,
            queueLength: this.status.queueLength ?? 0,
            lastError: this.status.lastError ?? null,
            url: serviceUrl(),
        };
    }

    getLogs(limit = 200) {
        return this.logs.slice(-Math.max(1, Math.min(limit, 500)));
    }

    private async waitUntilReady(): Promise<void> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 60_000) {
            const health = await this.refreshStatus().catch(() => null);
            if (health?.ready) return;
            await Bun.sleep(1000);
        }
        throw new Error('FunASR HTTP service startup timeout (60s)');
    }

    private async refreshStatus(): Promise<FunASRHealth> {
        const response = await fetch(new URL('/health', serviceUrl()), {
            signal: AbortSignal.timeout(1500),
        });
        const health = await response.json() as FunASRHealth;
        this.status = {
            ...health,
            ready: response.ok && Boolean(health.ready ?? health.ok),
            lastError: response.ok ? health.lastError ?? null : `HTTP ${response.status}`,
        };
        return this.status;
    }

    private async postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        const response = await fetch(new URL(path, serviceUrl()), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        }).catch(error => {
            throw new Error(`FunASR service is unreachable at ${serviceUrl()}: ${getErrorMessage(error)}`);
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`FunASR request failed status=${response.status}${detail ? ` detail=${detail.slice(0, 300)}` : ''}`);
        }
        const parsed = await response.json() as Record<string, unknown>;
        await this.refreshStatus().catch(() => undefined);
        return parsed;
    }

    private appendLog(level: 'info' | 'warn' | 'error', message: string): void {
        this.logs.push({ ts: Date.now(), level, message });
        if (this.logs.length > 500) {
            this.logs.splice(0, this.logs.length - 500);
        }
    }

    private recordReady(trigger: 'started' | 'already_ready', durationMs: number): void {
        const now = Date.now();
        const message = trigger === 'already_ready'
            ? '✅ FunASR 转译引擎加载成功. (已是就绪状态)'
            : '✅ FunASR 转译引擎加载成功.';
        this.appendLog('info', message);
        if (!this.readyConsolePrinted) {
            this.readyConsolePrinted = true;
            const detail = [
                `url=${serviceUrl()}`,
                `pid=${this.status.pid ?? 'unknown'}`,
                `model=${this.status.model ?? 'unknown'}`,
                `durationMs=${durationMs}`,
                `trigger=${trigger}`,
            ].join(' ');
            console.log(`[FunASR] ${message} ${detail}`);
        }
        if (trigger === 'already_ready' && now - this.lastReadyLogAt < 30_000) {
            return;
        }
        this.lastReadyLogAt = now;
        pipelineLogs.append({
            category: 'dashboard-service',
            level: 'info',
            title: 'service.start',
            message,
            timings: [{ key: 'service_start', label: 'FunASR 启动', durationMs }],
            metadata: {
                serviceId: 'funasr',
                ready: true,
                durationMs,
                url: serviceUrl(),
                trigger,
                pid: this.status.pid ?? null,
                uptimeSeconds: this.status.uptimeSeconds ?? null,
                model: this.status.model ?? null,
            },
            pipelineId: 'funasr',
        });
    }
}

export const funasrService = FunASRService.getInstance();

function normalizeAnalysis(value: unknown): FunASRMaterialAnalysis {
    if (!value || typeof value !== 'object') return emptyAnalysis('');
    const parsed = value as Partial<FunASRMaterialAnalysis>;
    return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        segments: Array.isArray(parsed.segments)
            ? parsed.segments.map(normalizeSegment).filter((segment): segment is FunASRMaterialSegment => segment !== null)
            : [],
        raw: parsed.raw,
    };
}

function normalizeSegment(value: unknown): FunASRMaterialSegment | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    const startMs = Number(item.start_ms);
    const endMs = Number(item.end_ms);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null;
    }
    return {
        start_ms: Math.max(0, Math.round(startMs)),
        end_ms: Math.max(0, Math.round(endMs)),
        text,
        spk: typeof item.spk === 'string' && item.spk.trim() ? item.spk.trim() : 'SPK0',
        confidence: typeof item.confidence === 'number' ? item.confidence : null,
    };
}

function emptyAnalysis(text: string): FunASRMaterialAnalysis {
    return {
        text,
        segments: [],
    };
}

async function runPythonServiceManager(args: string[]): Promise<void> {
    await execFileAsync(resolveServiceManager(), args, {
        cwd: process.cwd(),
        env: getPythonServiceEnv(),
        timeout: 90_000,
    });
}

function resolveServiceManager(): string {
    return `${GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_SCRIPT_ROOT}/bin/manage`;
}

function getPythonServiceEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        PYTHON_SERVICES_ROOT: GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_ROOT,
        PYTHON_SERVICES_DEVICE: GLOBAL_CONFIG.VOICE.PYTHON_SERVICES_DEVICE,
        FUNASR_PORT: String(GLOBAL_CONFIG.VOICE.FUNASR_PORT),
        FUNASR_MODEL: GLOBAL_CONFIG.VOICE.FUNASR_MODEL,
        FUNASR_MATERIAL_MODEL: GLOBAL_CONFIG.VOICE.FUNASR_MATERIAL_MODEL,
        FUNASR_PUNC_MODEL: GLOBAL_CONFIG.VOICE.FUNASR_PUNC_MODEL,
        FUNASR_SPK_MODEL: GLOBAL_CONFIG.VOICE.FUNASR_SPK_MODEL,
    };
}

function serviceUrl(): string {
    return GLOBAL_CONFIG.VOICE.FUNASR_BASE_URL;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
