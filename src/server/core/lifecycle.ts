export type ShutdownTask = {
    name: string;
    run: () => void | Promise<void>;
};

type LifecycleLogger = Pick<Console, 'log' | 'warn' | 'error'>;

type LifecycleManagerOptions = {
    exit?: (code: number) => void;
    logger?: LifecycleLogger;
};

/**
 * 集中管理系统所有服务的进程级生命周期。
 */
export class LifecycleManager {
    private static readonly defaultManager = new LifecycleManager();
    private static readonly signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    private static initialized = false;

    private readonly tasks: ShutdownTask[] = [];
    private readonly exit: (code: number) => void;
    private readonly logger: LifecycleLogger;
    private shutdownPromise: Promise<void> | null = null;

    constructor(options: LifecycleManagerOptions = {}) {
        this.exit = options.exit ?? ((code) => process.exit(code));
        this.logger = options.logger ?? console;
    }

    static init(): void {
        if (this.initialized) return;
        this.initialized = true;

        this.signals.forEach((signal) => {
            process.on(signal, () => {
                void this.shutdown(signal);
            });
        });

        process.on('uncaughtException', (error) => {
            console.error('🔥 Uncaught Exception:', error);
            void this.shutdown('ERROR');
        });

        process.on('unhandledRejection', (reason) => {
            console.error('🔥 Unhandled Rejection:', reason);
            void this.shutdown('ERROR');
        });
    }

    static registerShutdownTask(name: string, run: ShutdownTask['run']): void {
        this.defaultManager.registerShutdownTask(name, run);
    }

    static async shutdown(signal: string): Promise<void> {
        return this.defaultManager.shutdown(signal);
    }

    registerShutdownTask(name: string, run: ShutdownTask['run']): void {
        this.tasks.push({ name, run });
    }

    async shutdown(signal: string): Promise<void> {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }

        this.shutdownPromise = this.runShutdown(signal);
        return this.shutdownPromise;
    }

    private async runShutdown(signal: string): Promise<void> {
        this.logger.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
        let exitCode = signal === 'ERROR' ? 1 : 0;

        for (const task of this.tasks) {
            try {
                this.logger.log(`🔌 Stopping ${task.name}...`);
                await task.run();
            } catch (error) {
                exitCode = 1;
                this.logger.error(`❌ Shutdown task failed: ${task.name}`, error);
            }
        }

        if (exitCode === 0) {
            this.logger.log('✅ All services stopped. Goodbye!');
        } else {
            this.logger.warn('⚠️ Shutdown completed with errors.');
        }
        this.exit(exitCode);
    }
}
