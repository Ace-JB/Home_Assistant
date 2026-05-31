import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { GLOBAL_CONFIG } from '@/global_config';

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

type FunASRRequestMode = 'text' | 'material';

/**
 * FunASR 持续服务类 (Singleton)
 * 管理常驻内存的 Python 模型进程
 */
export class FunASRService {
    private static instance: FunASRService;
    private process: ChildProcess | null = null;
    private isReady = false;
    private activeRequest: {
        wavPath: string;
        mode: FunASRRequestMode;
        resolve: (value: string | FunASRMaterialAnalysis) => void;
    } | null = null;
    private requestQueue: Array<{
        wavPath: string;
        mode: FunASRRequestMode;
        resolve: (value: string | FunASRMaterialAnalysis) => void;
    }> = [];
    private startPromise: Promise<void> | null = null;
    private startedAt = 0;
    private lastError: string | null = null;
    private logs: Array<{ ts: number; level: 'info' | 'warn' | 'error'; message: string }> = [];

    private constructor() {}

    public static getInstance(): FunASRService {
        if (!FunASRService.instance) {
            FunASRService.instance = new FunASRService();
        }
        return FunASRService.instance;
    }

    async start() {
        if (this.isReady) return;
        if (this.startPromise) return this.startPromise;

        this.startPromise = new Promise<void>((resolve, reject) => {
            const cmdParts = parseCommand(GLOBAL_CONFIG.VOICE.FUNASR_CMD);
            const cmd = cmdParts[0]!;
            const baseArgs = cmdParts.slice(1);

            console.log('⏳ Loading FunASR model into memory...');
            this.appendLog('info', 'Loading FunASR model into memory...');
            this.appendLog('info', `Starting FunASR command: ${GLOBAL_CONFIG.VOICE.FUNASR_CMD}`);

            this.process = spawn(cmd, [
                ...baseArgs,
                '--model', GLOBAL_CONFIG.VOICE.FUNASR_MODEL,
                '--material-model', GLOBAL_CONFIG.VOICE.FUNASR_MATERIAL_MODEL,
                '--cache', GLOBAL_CONFIG.MODELS.BASE_PATH,
                '--punc-model', GLOBAL_CONFIG.VOICE.FUNASR_PUNC_MODEL,
                '--spk-model', GLOBAL_CONFIG.VOICE.FUNASR_SPK_MODEL,
            ]);

            const timeout = setTimeout(() => {
                const error = new Error('FunASR Service startup timeout (60s)');
                this.lastError = error.message;
                this.appendLog('error', error.message);
                this.process?.kill();
                this.process = null;
                this.startPromise = null;
                reject(error);
            }, 60000);

            this.process.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === 'READY') {
                        clearTimeout(timeout);
                        this.isReady = true;
                        this.startedAt = Date.now();
                        this.lastError = null;
                        console.log('✅ FunASR Service Ready (Model Loaded)');
                        this.appendLog('info', 'FunASR Service Ready (Model Loaded)');
                        resolve();
                    } else if (trimmedLine.startsWith('RESULT:')) {
                        const text = trimmedLine.replace('RESULT:', '').trim();
                        this.resolveActive(text);
                    } else if (trimmedLine.startsWith('JSON_RESULT:')) {
                        const json = trimmedLine.replace('JSON_RESULT:', '').trim();
                        this.resolveActive(this.parseAnalysis(json));
                    } else if (trimmedLine.startsWith('ERROR:')) {
                        console.error('[FunASR Service Error]', trimmedLine);
                        this.lastError = trimmedLine;
                        this.appendLog('error', trimmedLine);
                        this.resolveActive('');
                    }
                }
            });

            this.process.stderr?.on('data', (data) => {
                const msg = data.toString().trim();
                // 仅记录严重错误，忽略加载日志
                if (msg.includes('Traceback') || msg.includes('Error')) {
                    console.error(`[FunASR Service Stderr] ${msg}`);
                    const normalized = normalizeStartupError(msg);
                    this.lastError = normalized;
                    this.appendLog('error', normalized);
                } else if (msg) {
                    this.appendLog('info', msg);
                }
            });

            this.process.once('error', (error) => {
                this.lastError = error.message;
                this.appendLog('error', `Process error: ${error.message}`);
                clearTimeout(timeout);
                this.startPromise = null;
                reject(error);
            });

            this.process.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    console.error(`❌ FunASR Service crashed with code ${code}`);
                    this.lastError = `FunASR Service exited with code ${code}`;
                    this.appendLog('error', this.lastError);
                } else {
                    this.appendLog('info', 'FunASR Service stopped');
                }
                this.isReady = false;
                this.process = null;
                this.startPromise = null;
                this.startedAt = 0;
                this.resolveActive('');
                while (this.requestQueue.length > 0) {
                    this.requestQueue.shift()?.resolve('');
                }
            });

            this.process.once('spawn', () => {
                this.appendLog('info', `Spawned FunASR process pid=${this.process?.pid ?? 'unknown'}`);
            });
        });

        return this.startPromise;
    }

    async transcribe(wavPath: string): Promise<string> {
        await this.start();
        return new Promise((resolve) => {
            this.requestQueue.push({
                wavPath,
                mode: 'text',
                resolve: (value) => resolve(typeof value === 'string' ? value : value.text),
            });
            this.processNext();
        });
    }

    async analyzeMaterial(wavPath: string): Promise<FunASRMaterialAnalysis> {
        await this.start();
        return new Promise((resolve) => {
            this.requestQueue.push({
                wavPath,
                mode: 'material',
                resolve: (value) => resolve(typeof value === 'string' ? emptyAnalysis(value) : value),
            });
            this.processNext();
        });
    }

    stop() {
        if (this.process) {
            this.appendLog('info', 'Stopping FunASR Service...');
            this.process.stdin?.write('EXIT\n');
            this.process.kill();
            this.process = null;
            this.isReady = false;
            this.startPromise = null;
            this.startedAt = 0;
            this.resolveActive('');
            while (this.requestQueue.length > 0) {
                this.requestQueue.shift()?.resolve('');
            }
        }
    }

    getStatus() {
        return {
            ready: this.isReady,
            starting: this.startPromise !== null && !this.isReady,
            pid: this.process?.pid ?? null,
            startedAt: this.startedAt || null,
            uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : null,
            queueLength: this.requestQueue.length + (this.activeRequest ? 1 : 0),
            lastError: this.lastError,
        };
    }

    getLogs(limit = 200) {
        return this.logs.slice(-Math.max(1, Math.min(limit, 500)));
    }

    private appendLog(level: 'info' | 'warn' | 'error', message: string): void {
        this.logs.push({ ts: Date.now(), level, message });
        if (this.logs.length > 500) {
            this.logs.splice(0, this.logs.length - 500);
        }
    }

    private processNext(): void {
        if (this.activeRequest || !this.process || !this.process.stdin) {
            return;
        }
        const request = this.requestQueue.shift();
        if (!request) {
            return;
        }
        this.activeRequest = request;
        if (request.mode === 'material') {
            this.process.stdin.write(`${JSON.stringify({ mode: 'material', path: request.wavPath })}\n`);
            return;
        }
        this.process.stdin.write(`${request.wavPath}\n`);
    }

    private resolveActive(value: string | FunASRMaterialAnalysis): void {
        const request = this.activeRequest;
        this.activeRequest = null;
        request?.resolve(value);
        this.processNext();
    }

    private parseAnalysis(json: string): FunASRMaterialAnalysis {
        try {
            const parsed = JSON.parse(json) as Partial<FunASRMaterialAnalysis>;
            return {
                text: typeof parsed.text === 'string' ? parsed.text : '',
                segments: Array.isArray(parsed.segments)
                    ? parsed.segments.map(normalizeSegment).filter((segment): segment is FunASRMaterialSegment => segment !== null)
                    : [],
                raw: parsed.raw,
            };
        } catch (error) {
            console.error('[FunASR Service Error] failed to parse JSON result:', error);
            return emptyAnalysis('');
        }
    }
}

export const funasrService = FunASRService.getInstance();

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

function parseCommand(command: string): string[] {
    const parts = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    return parts.map(part => {
        if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
            return part.slice(1, -1);
        }
        return part;
    });
}

function normalizeStartupError(message: string): string {
    if (message.includes('torch/_C') && message.includes('library load denied by system policy')) {
        return [
            message,
            'Hint: the active Python can import funasr but its PyTorch binary is blocked by macOS code-signing policy.',
            'Set FUNASR_CMD to a healthy Python environment, for example: FUNASR_CMD="/path/to/venv/bin/python src/server/scripts/funasr_service.py".',
        ].join('\n');
    }
    return message;
}
