import type { TaskTiming } from './types';

export type TaskTimer = ReturnType<typeof createTaskTimer>;

export type TaskTimerOptions = {
    onMark?: (timing: TaskTiming) => void;
};

export function createTaskTimer(options: TaskTimerOptions = {}) {
    const startedAt = Date.now();
    const timings: TaskTiming[] = [];
    let finished = false;

    return {
        mark(key: string, label: string, markStartedAt: number, detail?: string) {
            const timing = {
                key,
                label,
                durationMs: Math.max(0, Date.now() - markStartedAt),
                ...(detail ? { detail } : {}),
            };
            timings.push(timing);
            options.onMark?.(timing);
        },
        finish() {
            if (!finished) {
                finished = true;
                const timing = {
                    key: 'total',
                    label: '总耗时',
                    durationMs: Math.max(0, Date.now() - startedAt),
                };
                timings.push(timing);
                options.onMark?.(timing);
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
