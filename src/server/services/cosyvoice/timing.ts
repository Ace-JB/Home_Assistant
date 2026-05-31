import type { TaskTiming } from './types';

export type TaskTimer = ReturnType<typeof createTaskTimer>;

export function createTaskTimer() {
    const startedAt = Date.now();
    const timings: TaskTiming[] = [];
    let finished = false;

    return {
        mark(key: string, label: string, markStartedAt: number, detail?: string) {
            timings.push({
                key,
                label,
                durationMs: Math.max(0, Date.now() - markStartedAt),
                ...(detail ? { detail } : {}),
            });
        },
        finish() {
            if (!finished) {
                finished = true;
                timings.push({
                    key: 'total',
                    label: '总耗时',
                    durationMs: Math.max(0, Date.now() - startedAt),
                });
            }
            return timings;
        },
    };
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
