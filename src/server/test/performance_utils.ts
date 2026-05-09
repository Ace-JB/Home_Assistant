export async function measurePerformance<T>(name: string, fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    const duration = end - start;
    console.log(`[Performance] ${name} took ${duration.toFixed(2)}ms`);
    return { result, duration };
}

export function logPerformanceResult(name: string, duration: number) {
    console.log(`[Performance Report] ${name}: ${duration.toFixed(2)}ms`);
}
