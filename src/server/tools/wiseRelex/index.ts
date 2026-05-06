import { syncManager } from "@/server/modules/media";
import { GLOBAL_CONFIG } from "@/global_config";
import { queue } from "../Queue";

/**
 * 频率控制阀门类
 */
class DetectionValve {
    private lastRunTime: number = 0;
    private interval: number;

    constructor(fps: number = GLOBAL_CONFIG.FACE.PROCESS_HZ) { // 默认每秒检测 2 次
        this.interval = 1000 / fps;
    }

    /**
     * 检查当前是否允许执行检测
     */
    canExecute(): boolean {
        const now = Date.now();
        if (now - this.lastRunTime >= this.interval) {
            this.lastRunTime = now;
            return true;
        }
        return false;
    }
}

export const faceValue = new DetectionValve(GLOBAL_CONFIG.FACE.PROCESS_HZ);


// 定义紧急程度级别
export enum Urgency {
    LOW = 'LOW',       // 常规检测，如路人经过
    MEDIUM = 'MEDIUM', // 疑似异常，如陌生人长时间徘徊
    HIGH = 'HIGH'      // 极度危险，如触发报警或特定关键词
}

/**
 * delayMs: 系统延迟，算法检测到问题到系统开始处理的时间
 * clipDurationMs: 捕获时长，处理完后获取的视频时长
 * cooldownMs: 冷却时间，处理完后到下次处理的时间 (实际时长为: delayMs + cooldownMs)
 */
// 策略映射表
export const URGENCY_POLICIES = {
    [Urgency.LOW]: {
        delayMs: 8000,         // 8s 后合成
        clipDurationMs: 12000, // 包含触发前约 4s 和后 8s
        cooldownMs: 2000       // 2s 冷却
    },
    [Urgency.MEDIUM]: {
        delayMs: 15000,
        clipDurationMs: 20000, // 包含触发前约 5s 和后 15s
        cooldownMs: 2000       // 2s 冷却
    },
    [Urgency.HIGH]: {
        delayMs: 25000,
        clipDurationMs: 30000, // 包含触发前约 5s 和后 25s
        cooldownMs: 2000       // 2s 冷却
    }
};

// 状态锁
let isSaving = false;

/**
 * 带有紧急程度权重的延迟取证保存
 * @param urgency 紧急级别
 */
export async function triggerUrgencySave(urgency: Urgency = Urgency.LOW) {

    if (isSaving) return;

    isSaving = true;

    const policy = URGENCY_POLICIES[urgency];


    console.log(`🚨 [${urgency}] 级别警报：将在 ${policy.delayMs / 1000}s 后捕获时长为 ${policy.clipDurationMs / 1000}s 的视频`);

    setTimeout(async () => {
        try {
            // 获取对应长度的同步快照
            const snapshot = syncManager.getSnapshot(policy.clipDurationMs);

            console.log(`🎬 正在执行 [${urgency}] 级别的视频合成...`);

            // ✅ 关键修复：await queue.push() 确保等到 FFmpeg 合成真正完成，
            //    而不是任务仅入队后就立即进入 finally，导致锁提前释放。
            await queue.push({ snapshot, urgency });

            // 这里可以添加通知逻辑：如果是 HIGH，通过局域网给手机发推送
            if (urgency === Urgency.HIGH) {
                // sendLANNotification("极高危告警：视频已录制并保存");
            }

        } catch (error) {
            console.error(`❌ [${urgency}] 视频合成失败:`, error);
        } finally {
            // FFmpeg 合成已完成（或失败），此时再开始冷却计时，释放状态锁
            setTimeout(() => {
                isSaving = false;
                console.log(`🔄 [${urgency}] 任务冷却结束，恢复检测`);
            }, policy.cooldownMs);
        }
    }, policy.delayMs);
}
