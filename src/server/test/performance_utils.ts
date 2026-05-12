export type PerformanceCategory =
    | "face-inference"
    | "media-synthesis"
    | "sync-buffer"
    | "socket-audio"
    | "voice"
    | "general";

export interface PerformanceMetric {
    name: string;
    duration: number;
    category: PerformanceCategory;
    timestamp: string;
    thresholdMs?: number;
    passedThreshold?: boolean;
}

export interface MeasurePerformanceOptions {
    category?: PerformanceCategory;
    thresholdMs?: number;
}

const performanceMetrics: PerformanceMetric[] = [];

export function categorizePerformanceMetric(name: string): PerformanceCategory {
    if (/FaceEngine|face/i.test(name)) return "face-inference";
    if (/safeSave|Queue|MediaSave|Video/i.test(name)) return "media-synthesis";
    if (/SyncManager|sync/i.test(name)) return "sync-buffer";
    if (/Socket|Pcm|PCM|audio level/i.test(name)) return "socket-audio";
    if (/Voice|normalize|transcript/i.test(name)) return "voice";
    return "general";
}

export function recordPerformanceMetric(
    name: string,
    duration: number,
    options: MeasurePerformanceOptions = {},
): PerformanceMetric {
    const thresholdMs = options.thresholdMs;
    const metric: PerformanceMetric = {
        name,
        duration,
        category: options.category ?? categorizePerformanceMetric(name),
        timestamp: new Date().toISOString(),
        thresholdMs,
        passedThreshold: thresholdMs === undefined ? undefined : duration <= thresholdMs,
    };

    performanceMetrics.push(metric);
    return metric;
}

export function getPerformanceMetrics(): PerformanceMetric[] {
    return [...performanceMetrics];
}

export function clearPerformanceMetrics(): void {
    performanceMetrics.length = 0;
}

export async function measurePerformance<T>(
    name: string,
    fn: () => Promise<T>,
    options: MeasurePerformanceOptions = {},
): Promise<{ result: T; duration: number; metric: PerformanceMetric }> {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    const duration = end - start;
    const metric = recordPerformanceMetric(name, duration, options);
    console.log(`[Performance] ${name} took ${duration.toFixed(2)}ms`);
    return { result, duration, metric };
}

export function logPerformanceResult(name: string, duration: number, options: MeasurePerformanceOptions = {}) {
    recordPerformanceMetric(name, duration, options);
    console.log(`[Performance Report] ${name}: ${duration.toFixed(2)}ms`);
}
