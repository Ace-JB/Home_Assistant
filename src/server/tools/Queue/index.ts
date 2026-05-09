import type { SyncSnapshot } from "@/server/modules/media";
import { safeSave } from "@modules/media/synthesizer";

interface VideoSaveTask {
    snapshot: SyncSnapshot;
    urgency: string;
    resolve: () => void;
    reject: (err: unknown) => void;
}

export class VideoSavingQueue {
    private queue: VideoSaveTask[] = [];
    private isProcessing = false;

    /**
     * 将任务压入队列，返回 Promise，在 safeSave 真正完成后 resolve。
     * 调用方可以 await 此 Promise 来感知任务实际完成时机。
     */
    push(task: Omit<VideoSaveTask, 'resolve' | 'reject'>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.queue.push({ ...task, resolve, reject });
            this.run();
        });
    }

    private async run() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        const task = this.queue.shift()!;

        try {
            await safeSave(task.snapshot, task.urgency);
            task.resolve();
        } catch (err) {
            console.error("Queue task failed:", err);
            task.reject(err);
        } finally {
            this.isProcessing = false;
            // 只有队列中还有任务时才继续消费，不做空跑轮询
            if (this.queue.length > 0) {
                this.run();
            }
        }
    }
}

export const queue = new VideoSavingQueue();
