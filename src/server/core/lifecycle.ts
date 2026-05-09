import { funasrService } from "@server/services/FunASRService";

/**
 * 集中管理系统所有服务的生命周期
 */
export class LifecycleManager {
    private static signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    private static isShuttingDown = false;

    static init() {
        this.signals.forEach(signal => {
            process.on(signal, () => this.shutdown(signal));
        });

        // 捕获未处理的异常
        process.on('uncaughtException', (error) => {
            console.error('🔥 Uncaught Exception:', error);
            this.shutdown('ERROR');
        });

        process.on('unhandledRejection', (reason) => {
            console.error('🔥 Unhandled Rejection:', reason);
            this.shutdown('ERROR');
        });
    }

    static async shutdown(signal: string) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

        try {
            // 1. 停止 FunASR 外部进程
            console.log('🔌 Stopping FunASR Service...');
            funasrService.stop();

            // 2. 这里可以添加其他服务的停止逻辑
            // 例如：close camera, stop monitor, etc.

            console.log('✅ All services stopped. Goodbye!');
            process.exit(0);
        } catch (error) {
            console.error('❌ Error during shutdown:', error);
            process.exit(1);
        }
    }
}
