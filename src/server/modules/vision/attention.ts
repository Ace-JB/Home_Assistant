import { GLOBAL_CONFIG } from '@/global_config';
import { pipelineLogs } from '@server/services/PipelineLogService';
import { isVisionProfile, type VisionProfile } from '@/shared/vision/types';

export type VisionAttentionSource = 'baseline' | 'wake' | 'intent' | 'ui' | 'vision-event';

export type VisionAttentionRequest = {
    id: string;
    source: VisionAttentionSource;
    profile: VisionProfile;
    priority: number;
    reason: string;
    createdAt: number;
    expiresAt: number;
};

export type VisionAttentionSnapshot = {
    activeProfile: VisionProfile;
    activeReason: string;
    hasActiveRequest: boolean;
    idleSince: number | null;
    idleMs: number;
    requests: VisionAttentionRequest[];
    lastTransitionAt: number;
};

type RequestInput = {
    id?: string;
    source: VisionAttentionSource;
    profile: VisionProfile;
    priority: number;
    reason: string;
    ttlMs: number;
    now?: number;
};

const PROFILE_RANK: Record<VisionProfile, number> = {
    identity: 0,
    perception: 1,
    full: 2,
};

function normalizeProfile(value: string | undefined, fallback: VisionProfile): VisionProfile {
    return isVisionProfile(value) ? value : fallback;
}

function createRequestId(source: VisionAttentionSource, createdAt: number): string {
    return `${source}-${createdAt}-${Math.random().toString(16).slice(2)}`;
}

export class VisionAttentionManager {
    private requests = new Map<string, VisionAttentionRequest>();
    private activeProfile: VisionProfile;
    private activeReason = 'baseline';
    private lastTransitionAt: number;
    private idleSince: number | null = null;

    constructor(
        private readonly defaultProfile: VisionProfile = normalizeProfile(
            GLOBAL_CONFIG.VISION.DEFAULT_PROFILE,
            'identity',
        ),
    ) {
        this.activeProfile = defaultProfile;
        this.lastTransitionAt = Date.now();
    }

    request(input: RequestInput): VisionAttentionRequest {
        const createdAt = input.now ?? Date.now();
        const request: VisionAttentionRequest = {
            id: input.id ?? createRequestId(input.source, createdAt),
            source: input.source,
            profile: input.profile,
            priority: input.priority,
            reason: input.reason,
            createdAt,
            expiresAt: createdAt + Math.max(0, input.ttlMs),
        };
        this.requests.set(request.id, request);
        this.resolve(createdAt);
        return request;
    }

    clearSource(source: VisionAttentionSource, now = Date.now()): void {
        for (const [id, request] of this.requests.entries()) {
            if (request.source === source) {
                this.requests.delete(id);
            }
        }
        this.resolve(now);
    }

    clear(id: string, now = Date.now()): void {
        this.requests.delete(id);
        this.resolve(now);
    }

    reset(reason = 'reset', now = Date.now()): void {
        this.requests.clear();
        this.transition(this.defaultProfile, reason, now);
        this.updateIdleState(now, false);
    }

    resolve(now = Date.now()): VisionAttentionSnapshot {
        this.pruneExpired(now);
        const winner = this.getWinningRequest();
        const nextProfile = winner?.profile ?? this.defaultProfile;
        const reason = winner?.reason ?? 'baseline';
        this.transition(nextProfile, reason, now, winner);
        this.updateIdleState(now, Boolean(winner));
        return this.createSnapshot(now);
    }

    snapshot(now = Date.now()): VisionAttentionSnapshot {
        this.pruneExpired(now);
        const winner = this.getWinningRequest();
        this.transition(winner?.profile ?? this.defaultProfile, winner?.reason ?? 'baseline', now, winner);
        this.updateIdleState(now, Boolean(winner));
        return this.createSnapshot(now);
    }

    private pruneExpired(now: number): void {
        for (const [id, request] of this.requests.entries()) {
            if (request.expiresAt <= now) {
                this.requests.delete(id);
            }
        }
    }

    private updateIdleState(now: number, hasActiveRequest: boolean): void {
        if (hasActiveRequest || this.activeProfile !== this.defaultProfile) {
            this.idleSince = null;
            return;
        }
        this.idleSince ??= now;
    }

    private getWinningRequest(): VisionAttentionRequest | undefined {
        return [...this.requests.values()].sort(compareRequests)[0];
    }

    private transition(
        nextProfile: VisionProfile,
        reason: string,
        now: number,
        request?: VisionAttentionRequest,
    ): void {
        if (nextProfile === this.activeProfile && reason === this.activeReason) {
            return;
        }
        const previousProfile = this.activeProfile;
        this.activeProfile = nextProfile;
        this.activeReason = reason;
        this.lastTransitionAt = now;

        pipelineLogs.append({
            category: 'vision',
            level: 'info',
            title: 'vision.attention.transition',
            message: `Vision attention ${previousProfile} -> ${nextProfile}`,
            metadata: {
                fromProfile: previousProfile,
                toProfile: nextProfile,
                source: request?.source ?? 'baseline',
                reason,
                ttlMs: request ? Math.max(0, request.expiresAt - now) : 0,
            },
            pipelineId: 'vision-attention',
        });
    }

    private createSnapshot(now = Date.now()): VisionAttentionSnapshot {
        const hasActiveRequest = this.requests.size > 0;
        return {
            activeProfile: this.activeProfile,
            activeReason: this.activeReason,
            hasActiveRequest,
            idleSince: this.idleSince,
            idleMs: this.idleSince === null ? 0 : Math.max(0, now - this.idleSince),
            requests: [...this.requests.values()].sort(compareRequests),
            lastTransitionAt: this.lastTransitionAt,
        };
    }
}

function compareRequests(a: VisionAttentionRequest, b: VisionAttentionRequest): number {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (PROFILE_RANK[a.profile] !== PROFILE_RANK[b.profile]) {
        return PROFILE_RANK[b.profile] - PROFILE_RANK[a.profile];
    }
    return b.createdAt - a.createdAt;
}

const VISION_ATTENTION_KEY = Symbol.for('home-assistant.visionAttention');

export function getVisionAttentionManager(): VisionAttentionManager {
    const globalScope = globalThis as typeof globalThis & { [VISION_ATTENTION_KEY]?: VisionAttentionManager };
    if (!globalScope[VISION_ATTENTION_KEY]) {
        globalScope[VISION_ATTENTION_KEY] = new VisionAttentionManager();
    }
    return globalScope[VISION_ATTENTION_KEY]!;
}

export const visionAttention = getVisionAttentionManager();
