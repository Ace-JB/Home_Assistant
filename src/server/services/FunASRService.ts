import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { GLOBAL_CONFIG } from '@/global_config';

/**
 * FunASR 持续服务类 (Singleton)
 * 管理常驻内存的 Python 模型进程
 */
export class FunASRService {
    private static instance: FunASRService;
    private process: ChildProcess | null = null;
    private isReady = false;
    private pendingResolver: ((text: string) => void) | null = null;
    private startPromise: Promise<void> | null = null;

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
            const cmdParts = GLOBAL_CONFIG.VOICE.FUNASR_CMD.split(' ');
            const cmd = cmdParts[0]!;
            const baseArgs = cmdParts.slice(1);

            console.log('⏳ Loading FunASR model into memory...');

            this.process = spawn(cmd, [
                ...baseArgs,
                '--model', GLOBAL_CONFIG.VOICE.FUNASR_MODEL,
                '--cache', GLOBAL_CONFIG.MODELS.BASE_PATH,
            ]);

            const timeout = setTimeout(() => {
                reject(new Error('FunASR Service startup timeout (60s)'));
            }, 60000);

            this.process.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === 'READY') {
                        clearTimeout(timeout);
                        this.isReady = true;
                        console.log('✅ FunASR Service Ready (Model Loaded)');
                        resolve();
                    } else if (trimmedLine.startsWith('RESULT:')) {
                        const text = trimmedLine.replace('RESULT:', '').trim();
                        if (this.pendingResolver) {
                            this.pendingResolver(text);
                            this.pendingResolver = null;
                        }
                    } else if (trimmedLine.startsWith('ERROR:')) {
                        console.error('[FunASR Service Error]', trimmedLine);
                        if (this.pendingResolver) {
                            this.pendingResolver('');
                            this.pendingResolver = null;
                        }
                    }
                }
            });

            this.process.stderr?.on('data', (data) => {
                const msg = data.toString().trim();
                // 仅记录严重错误，忽略加载日志
                if (msg.includes('Traceback') || msg.includes('Error')) {
                    console.error(`[FunASR Service Stderr] ${msg}`);
                }
            });

            this.process.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    console.error(`❌ FunASR Service crashed with code ${code}`);
                }
                this.isReady = false;
                this.process = null;
                this.startPromise = null;
            });
        });

        return this.startPromise;
    }

    async transcribe(wavPath: string): Promise<string> {
        await this.start();
        return new Promise((resolve) => {
            if (!this.process || !this.process.stdin) {
                resolve('');
                return;
            }
            this.pendingResolver = resolve;
            this.process.stdin.write(`${wavPath}\n`);
        });
    }

    stop() {
        if (this.process) {
            this.process.stdin?.write('EXIT\n');
            this.process.kill();
            this.process = null;
            this.isReady = false;
            this.startPromise = null;
        }
    }
}

export const funasrService = FunASRService.getInstance();
