import type { TaskTiming } from './types';

export type CosyVoiceMaterialJobType = 'probe-url' | 'import-url' | 'extract' | 'save';
export type CosyVoiceMaterialJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type CosyVoiceMaterialJobStageStatus = 'pending' | 'running' | 'done' | 'failed';

export type CosyVoiceMaterialJobStageDefinition = {
    key: string;
    percent: number;
};

export type CosyVoiceMaterialJobStage = CosyVoiceMaterialJobStageDefinition & {
    status: CosyVoiceMaterialJobStageStatus;
    detail?: string;
    durationMs?: number;
    startedAt?: string;
    elapsedMs?: number;
};

export type CosyVoiceMaterialJobSnapshot<T = unknown> = {
    id: string;
    type: CosyVoiceMaterialJobType;
    status: CosyVoiceMaterialJobStatus;
    percent: number;
    stageKey: string;
    stages: CosyVoiceMaterialJobStage[];
    timings: TaskTiming[];
    result?: T;
    error?: string;
    createdAt: string;
    updatedAt: string;
};

export type CosyVoiceMaterialJobStoreOptions = {
    now?: () => number;
    idFactory?: () => string;
    maxJobs?: number;
    ttlMs?: number;
};

const DEFAULT_MAX_JOBS = 100;
const DEFAULT_JOB_TTL_MS = 60 * 60 * 1000;

export class CosyVoiceMaterialJobStore {
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private readonly maxJobs: number;
    private readonly ttlMs: number;
    private readonly jobs = new Map<string, CosyVoiceMaterialJobSnapshot>();

    constructor(options: CosyVoiceMaterialJobStoreOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.idFactory = options.idFactory ?? (() => `voice-job-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
        this.maxJobs = Math.max(1, Math.floor(options.maxJobs ?? DEFAULT_MAX_JOBS));
        this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_JOB_TTL_MS));
    }

    createJob(type: CosyVoiceMaterialJobType, stages: CosyVoiceMaterialJobStageDefinition[]): CosyVoiceMaterialJobSnapshot {
        this.cleanup();
        const timestamp = toIsoString(this.now());
        const normalizedStages = stages.length > 0 ? stages : [{ key: 'done', percent: 100 }];
        const job: CosyVoiceMaterialJobSnapshot = {
            id: this.idFactory(),
            type,
            status: 'queued',
            percent: 0,
            stageKey: normalizedStages[0]?.key ?? 'done',
            stages: normalizedStages.map(stage => ({
                key: stage.key,
                percent: clampPercent(stage.percent),
                status: 'pending',
            })),
            timings: [],
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.jobs.set(job.id, job);
        this.trimToCapacity();
        return cloneJob(job);
    }

    getJob(id: string): CosyVoiceMaterialJobSnapshot | null {
        this.cleanup();
        const job = this.jobs.get(id);
        return job ? cloneJob(job, this.now()) : null;
    }

    updateStage(id: string, stageKey: string, detail?: string, percent?: number): CosyVoiceMaterialJobSnapshot | null {
        const current = this.jobs.get(id);
        if (!current) return null;

        const timestampMs = this.now();
        const timestamp = toIsoString(timestampMs);
        const targetPercent = percent ?? current.stages.find(stage => stage.key === stageKey)?.percent ?? current.percent;
        const nextStages = current.stages.map(stage => {
            if (stage.key === stageKey) {
                return {
                    ...stage,
                    status: 'running' as const,
                    startedAt: stage.startedAt ?? timestamp,
                    ...(detail ? { detail } : {}),
                };
            }
            if (stage.percent < targetPercent || (targetPercent >= 100 && stage.key !== stageKey)) {
                return { ...stage, status: stage.status === 'failed' ? stage.status : 'done' as const };
            }
            return stage;
        });
        const next = this.replaceJob(id, {
            ...current,
            status: 'running',
            percent: clampPercent(targetPercent),
            stageKey,
            stages: nextStages,
            updatedAt: timestamp,
        });
        return next ? cloneJob(next, timestampMs) : null;
    }

    completeStage(id: string, stageKey: string, timing: TaskTiming): CosyVoiceMaterialJobSnapshot | null {
        const current = this.jobs.get(id);
        if (!current) return null;

        const timestampMs = this.now();
        const stagePercent = current.stages.find(stage => stage.key === stageKey)?.percent ?? current.percent;
        const nextStages = current.stages.map(stage => stage.key === stageKey
            ? {
                ...stage,
                status: 'done' as const,
                durationMs: timing.durationMs,
                ...(timing.detail ? { detail: timing.detail } : {}),
            }
            : stage);
        const next = this.replaceJob(id, {
            ...current,
            status: current.status === 'queued' ? 'running' : current.status,
            percent: Math.max(current.percent, clampPercent(stagePercent)),
            stageKey,
            stages: nextStages,
            timings: [...current.timings, timing],
            updatedAt: toIsoString(timestampMs),
        });
        return next ? cloneJob(next, timestampMs) : null;
    }

    succeed<T>(id: string, result: T, timings: TaskTiming[] = []): CosyVoiceMaterialJobSnapshot<T> | null {
        const current = this.jobs.get(id);
        if (!current) return null;

        const timestampMs = this.now();
        const next = this.replaceJob(id, {
            ...current,
            status: 'succeeded',
            percent: 100,
            stageKey: 'done',
            stages: current.stages.map(stage => ({ ...stage, status: 'done' as const })),
            timings,
            result,
            updatedAt: toIsoString(timestampMs),
        });
        return next ? cloneJob(next, timestampMs) as CosyVoiceMaterialJobSnapshot<T> : null;
    }

    fail(id: string, error: unknown, timings?: TaskTiming[]): CosyVoiceMaterialJobSnapshot | null {
        const current = this.jobs.get(id);
        if (!current) return null;
        const message = error instanceof Error ? error.message : String(error || 'job failed');
        const activeStageKey = current.stageKey || current.stages.find(stage => stage.status === 'running')?.key || current.stages[0]?.key;
        const timestampMs = this.now();
        const next = this.replaceJob(id, {
            ...current,
            status: 'failed',
            percent: 100,
            stages: current.stages.map(stage => stage.key === activeStageKey
                ? { ...stage, status: 'failed' as const, detail: message }
                : stage),
            timings: timings ?? current.timings,
            error: message,
            updatedAt: toIsoString(timestampMs),
        });
        return next ? cloneJob(next, timestampMs) : null;
    }

    cleanup(): void {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, job] of this.jobs.entries()) {
            if (Date.parse(job.updatedAt) < cutoff) {
                this.jobs.delete(id);
            }
        }
        this.trimToCapacity();
    }

    private replaceJob(id: string, job: CosyVoiceMaterialJobSnapshot): CosyVoiceMaterialJobSnapshot | null {
        if (!this.jobs.has(id)) return null;
        this.jobs.set(id, job);
        return job;
    }

    private trimToCapacity(): void {
        while (this.jobs.size > this.maxJobs) {
            const oldest = this.jobs.keys().next().value as string | undefined;
            if (!oldest) return;
            this.jobs.delete(oldest);
        }
    }
}

export function parseYtDlpDownloadProgress(chunk: string): number | null {
    const match = chunk.match(/\[download\]\s+(\d+(?:\.\d+)?)%/u);
    if (!match?.[1]) return null;
    return clampPercent(Number(match[1]));
}

function cloneJob<T>(job: CosyVoiceMaterialJobSnapshot<T>, nowMs?: number): CosyVoiceMaterialJobSnapshot<T> {
    return {
        ...job,
        stages: job.stages.map(stage => cloneStage(stage, nowMs)),
        timings: job.timings.map(timing => ({ ...timing })),
        ...(job.result !== undefined ? { result: job.result } : {}),
    };
}

function cloneStage(stage: CosyVoiceMaterialJobStage, nowMs?: number): CosyVoiceMaterialJobStage {
    const elapsedMs = getRunningElapsedMs(stage, nowMs);
    return {
        key: stage.key,
        percent: stage.percent,
        status: stage.status,
        ...(stage.detail !== undefined ? { detail: stage.detail } : {}),
        ...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {}),
        ...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    };
}

function getRunningElapsedMs(stage: CosyVoiceMaterialJobStage, nowMs?: number): number | undefined {
    if (nowMs === undefined || stage.status !== 'running' || stage.durationMs !== undefined || !stage.startedAt) {
        return undefined;
    }
    const startedAtMs = Date.parse(stage.startedAt);
    if (!Number.isFinite(startedAtMs)) return undefined;
    return Math.max(0, Math.round(nowMs - startedAtMs));
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

function toIsoString(timestampMs: number): string {
    return new Date(timestampMs).toISOString();
}
