import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { GLOBAL_CONFIG } from '@/global_config';
import { getDataDbDir } from '@/server/services/runtime-paths';
import type { TaskTiming } from '@/server/services/cosyvoice/types';

export type PipelineKind =
    | 'system'
    | 'conversation';

export type PipelineStage =
    | 'wake'
    | 'asr'
    | 'intent'
    | 'context'
    | 'memory'
    | 'vision'
    | 'model'
    | 'tool'
    | 'tts'
    | 'service'
    | 'summary';

export type PipelineEventLevel = 'debug' | 'info' | 'warn' | 'error';

export type PipelineEventType =
    | 'stage_start'
    | 'stage_complete'
    | 'stage_failed'
    | 'model_call'
    | 'decision'
    | 'fallback'
    | 'repair'
    | 'artifact'
    | 'summary';

export type PipelineStatus = 'running' | 'completed' | 'failed';

export type PipelineRun = {
    id: string;
    kind: PipelineKind;
    status: PipelineStatus;
    title: string;
    conversationId?: string;
    userCommand?: string;
    startedAt: number;
    completedAt?: number;
    durationMs?: number;
    severity: PipelineEventLevel;
    summary?: unknown;
    metadata?: unknown;
    eventCount: number;
    incidentCount: number;
    modelCallCount: number;
};

export type PipelineEvent = {
    id: string;
    pipelineId: string;
    ts: number;
    stage: PipelineStage;
    eventType: PipelineEventType;
    level: PipelineEventLevel;
    title: string;
    message?: string;
    detail?: string;
    timings?: TaskTiming[];
    metadata?: unknown;
};

export type ModelCallRecord = {
    id: string;
    pipelineId: string;
    eventId?: string;
    ts: number;
    stage: PipelineStage;
    scope: string;
    modelId: string;
    status: 'started' | 'complete' | 'failed';
    durationMs?: number;
    inputChars?: number;
    outputChars?: number;
    promptPreview?: string;
    outputPreview?: string;
    error?: string;
    metadata?: unknown;
};

export type PipelineIncident = {
    id: string;
    pipelineId: string;
    eventId?: string;
    ts: number;
    stage: PipelineStage;
    severity: Exclude<PipelineEventLevel, 'debug' | 'info'>;
    reason: string;
    inputSnapshot?: string;
    outputSnapshot?: string;
    recommendedAction?: string;
    metadata?: unknown;
    summary?: string;
};

export type PipelineDetail = PipelineRun & {
    events: PipelineEvent[];
};

type PipelineRunInput = {
    id?: string;
    kind: PipelineKind;
    title: string;
    conversationId?: string | null;
    userCommand?: string | null;
    startedAt?: number;
    metadata?: unknown;
};

type PipelineEventInput = {
    id?: string;
    pipelineId?: string | null;
    conversationId?: string | null;
    ts?: number;
    stage: PipelineStage;
    eventType: PipelineEventType;
    level?: PipelineEventLevel;
    title: string;
    message?: string;
    detail?: string;
    timings?: TaskTiming[];
    metadata?: unknown;
};

type ModelCallInput = {
    id?: string;
    pipelineId?: string | null;
    conversationId?: string | null;
    eventId?: string;
    ts?: number;
    stage?: PipelineStage;
    scope: string;
    modelId: string;
    status: ModelCallRecord['status'];
    durationMs?: number;
    inputChars?: number;
    outputChars?: number;
    promptPreview?: string;
    outputPreview?: string;
    error?: string;
    metadata?: unknown;
};

type IncidentInput = {
    id?: string;
    pipelineId?: string | null;
    conversationId?: string | null;
    eventId?: string;
    ts?: number;
    stage: PipelineStage;
    severity?: 'warn' | 'error';
    reason: string;
    inputSnapshot?: unknown;
    outputSnapshot?: unknown;
    recommendedAction?: string;
    metadata?: unknown;
    summary?: string;
};

type CompletePipelineInput = {
    status?: PipelineStatus;
    completedAt?: number;
    summary?: unknown;
    metadata?: unknown;
};

type PipelineRunRow = {
    pipeline_id: string;
    kind: PipelineKind;
    status: PipelineStatus;
    title: string;
    conversation_id: string | null;
    user_command: string | null;
    started_at: number;
    completed_at: number | null;
    duration_ms: number | null;
    severity: PipelineEventLevel;
    summary_json: string | null;
    metadata_json: string | null;
};

type PipelineEventRow = {
    event_id: string;
    pipeline_id: string;
    ts: number;
    stage: PipelineStage;
    event_type: PipelineEventType;
    level: PipelineEventLevel;
    title: string;
    message: string | null;
    detail: string | null;
    timings_json: string | null;
    metadata_json: string | null;
};

type ModelCallRow = {
    model_call_id: string;
    pipeline_id: string;
    event_id: string | null;
    ts: number;
    stage: PipelineStage;
    scope: string;
    model_id: string;
    status: ModelCallRecord['status'];
    duration_ms: number | null;
    input_chars: number | null;
    output_chars: number | null;
    prompt_preview: string | null;
    output_preview: string | null;
    error: string | null;
    metadata_json: string | null;
};

type IncidentRow = {
    incident_id: string;
    pipeline_id: string;
    event_id: string | null;
    ts: number;
    stage: PipelineStage;
    severity: 'warn' | 'error';
    reason: string;
    input_snapshot: string | null;
    output_snapshot: string | null;
    recommended_action: string | null;
    metadata_json: string | null;
    summary: string | null;
};

type RuntimeLogInput = {
    id?: string;
    ts?: number;
    category?: string;
    pipelineId?: string;
    level?: PipelineEventLevel;
    title: string;
    message?: string;
    detail?: string;
    timings?: TaskTiming[];
    metadata?: unknown;
    traceId?: string;
    conversationId?: string;
};

const DEFAULT_MAX_EVENTS = 50_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DB_DIR = getDataDbDir();
const SQLITE_PIPELINE_LOG_DB_PATH = process.env.NODE_ENV === 'test'
    ? join(tmpdir(), 'home-assistant-pipeline-logs-test.sqlite')
    : join(DB_DIR, 'pipeline-logs.sqlite');

const LEVEL_RANK: Record<PipelineEventLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class PipelineLogService {
    private readonly sqlite: Database;

    constructor(private readonly maxEvents = DEFAULT_MAX_EVENTS, dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : SQLITE_PIPELINE_LOG_DB_PATH) {
        if (dbPath !== ':memory:') {
            mkdirSync(dirname(dbPath), { recursive: true });
        }
        this.sqlite = new Database(dbPath);
        this.sqlite.run('PRAGMA journal_mode = WAL');
        this.init();
    }

    append(input: RuntimeLogInput): PipelineEvent | null {
        return this.appendRuntimeEvent(input);
    }

    startPipeline(input: PipelineRunInput): PipelineRun {
        const id = input.id ?? createId('pipe');
        const startedAt = input.startedAt ?? Date.now();
        const kind = normalizeWritableKind(input.kind);
        this.sqlite
            .query(`
                INSERT OR REPLACE INTO pipeline_runs (
                    pipeline_id, kind, status, title, conversation_id, user_command,
                    started_at, completed_at, duration_ms, severity, summary_json, metadata_json
                )
                VALUES (
                    $id, $kind, 'running', $title, $conversationId, $userCommand,
                    $startedAt, NULL, NULL, 'info', NULL, $metadataJson
                )
            `)
            .run({
                $id: id,
                $kind: kind,
                $title: input.title,
                $conversationId: input.conversationId ?? null,
                $userCommand: input.userCommand ?? null,
                $startedAt: startedAt,
                $metadataJson: stringifyJson(input.metadata),
            });
        return this.getPipeline(id)!;
    }

    ensurePipeline(input: PipelineRunInput): PipelineRun {
        if (input.id) {
            const existing = this.getPipeline(input.id);
            if (existing) return existing;
        }
        return this.startPipeline(input);
    }

    appendEvent(input: PipelineEventInput): PipelineEvent {
        const pipeline = this.ensurePipeline(resolvePipelineRunInput(input));
        const event: PipelineEvent = {
            id: input.id ?? createId('evt'),
            pipelineId: pipeline.id,
            ts: input.ts ?? Date.now(),
            stage: input.stage,
            eventType: input.eventType,
            level: input.level ?? 'info',
            title: input.title,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
            ...(input.timings ? { timings: input.timings } : {}),
            metadata: boundedMetadata(input.metadata),
        };
        this.sqlite
            .query(`
                INSERT INTO pipeline_events (
                    event_id, pipeline_id, ts, stage, event_type, level, title,
                    message, detail, timings_json, metadata_json
                )
                VALUES (
                    $eventId, $pipelineId, $ts, $stage, $eventType, $level, $title,
                    $message, $detail, $timingsJson, $metadataJson
                )
            `)
            .run({
                $eventId: event.id,
                $pipelineId: event.pipelineId,
                $ts: event.ts,
                $stage: event.stage,
                $eventType: event.eventType,
                $level: event.level,
                $title: event.title,
                $message: event.message ?? null,
                $detail: event.detail ?? null,
                $timingsJson: stringifyJson(event.timings ?? null),
                $metadataJson: stringifyJson(event.metadata ?? null),
            });
        this.refreshPipelineSeverity(event.pipelineId);
        this.prune();
        return event;
    }

    appendRuntimeEvent(input: RuntimeLogInput): PipelineEvent | null {
        if (!shouldWriteRuntimePipelineEvent(input)) {
            return null;
        }
        const metadata = getRecord(input.metadata);
        const conversationId = input.conversationId ?? stringValue(metadata.conversationId) ?? stringValue(metadata.conversation_id);
        const systemEvent = input.category === 'dashboard-service'
            || (input.category === 'system' && !conversationId && input.title.startsWith('system.'));
        return this.appendEvent({
            id: input.id,
            ts: input.ts,
            pipelineId: systemEvent ? 'system' : input.pipelineId ?? input.conversationId ?? stringValue(metadata.pipelineId),
            conversationId: systemEvent ? undefined : conversationId,
            stage: stageFromRuntimeCategory(input.category, input.title),
            eventType: eventTypeFromLevel(input.level ?? 'info'),
            level: input.level ?? 'info',
            title: normalizeRuntimeTitle(input),
            message: input.message,
            detail: input.detail,
            timings: input.timings,
            metadata: cleanObject({
                ...metadata,
                pipelineKind: systemEvent ? 'system' : 'conversation',
                traceId: input.traceId ?? stringValue(metadata.traceId),
            }),
        });
    }

    recordModelCall(input: ModelCallInput): ModelCallRecord {
        if (input.id) {
            const existing = this.getModelCall(input.id);
            if (existing) {
                return this.updateModelCall(existing, input);
            }
        }
        const pipelineId = resolveLogAssociationId(input.pipelineId, input.conversationId, input.metadata);
        const pipeline = this.getPipeline(pipelineId);
        const record: ModelCallRecord = {
            id: input.id ?? createId('model'),
            pipelineId,
            ...(input.eventId ? { eventId: input.eventId } : {}),
            ts: input.ts ?? Date.now(),
            stage: input.stage ?? 'model',
            scope: input.scope,
            modelId: input.modelId,
            status: input.status,
            ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
            ...(input.inputChars !== undefined ? { inputChars: input.inputChars } : {}),
            ...(input.outputChars !== undefined ? { outputChars: input.outputChars } : {}),
            ...(input.promptPreview !== undefined ? { promptPreview: input.promptPreview } : {}),
            ...(input.outputPreview !== undefined ? { outputPreview: input.outputPreview } : {}),
            ...(input.error !== undefined ? { error: boundText(input.error) } : {}),
            metadata: boundedMetadata(input.metadata),
        };
        this.sqlite
            .query(`
                INSERT INTO model_calls (
                    model_call_id, pipeline_id, event_id, ts, stage, scope, model_id, status,
                    duration_ms, input_chars, output_chars, prompt_preview, output_preview, error, metadata_json
                )
                VALUES (
                    $id, $pipelineId, $eventId, $ts, $stage, $scope, $modelId, $status,
                    $durationMs, $inputChars, $outputChars, $promptPreview, $outputPreview, $error, $metadataJson
                )
            `)
            .run({
                $id: record.id,
                $pipelineId: record.pipelineId,
                $eventId: record.eventId ?? null,
                $ts: record.ts,
                $stage: record.stage,
                $scope: record.scope,
                $modelId: record.modelId,
                $status: record.status,
                $durationMs: record.durationMs ?? null,
                $inputChars: record.inputChars ?? null,
                $outputChars: record.outputChars ?? null,
                $promptPreview: record.promptPreview ?? null,
                $outputPreview: record.outputPreview ?? null,
                $error: record.error ?? null,
                $metadataJson: stringifyJson(record.metadata ?? null),
            });
        if (pipeline) {
            const event = this.appendEvent({
                pipelineId: record.pipelineId,
                ts: record.ts,
                stage: record.stage,
                eventType: 'model_call',
                level: record.status === 'failed' ? 'error' : 'info',
                title: 'Model call reference',
                timings: record.durationMs !== undefined
                    ? [{ key: 'model_call', label: record.scope, durationMs: record.durationMs, detail: record.error }]
                    : undefined,
                metadata: {
                    modelCallId: record.id,
                    scope: record.scope,
                    modelId: record.modelId,
                    status: record.status,
                    inputChars: record.inputChars ?? null,
                    outputChars: record.outputChars ?? null,
                },
            });
            if (!record.eventId) {
                this.sqlite.query('UPDATE model_calls SET event_id = ? WHERE model_call_id = ?').run(event.id, record.id);
                record.eventId = event.id;
            }
        }
        if (record.status === 'failed') {
            this.recordIncident({
                pipelineId: record.pipelineId,
                eventId: record.eventId,
                ts: record.ts,
                stage: record.stage,
                severity: 'error',
                reason: `model_call_failed:${record.scope}`,
                inputSnapshot: record.promptPreview,
                outputSnapshot: record.error,
                metadata: { modelCallId: record.id, modelId: record.modelId },
            });
        }
        this.refreshPipelineSeverity(record.pipelineId);
        return record;
    }

    private updateModelCall(existing: ModelCallRecord, input: ModelCallInput): ModelCallRecord {
        const record: ModelCallRecord = {
            ...existing,
            status: input.status,
            ts: input.ts ?? existing.ts,
            stage: input.stage ?? existing.stage,
            scope: input.scope,
            modelId: input.modelId,
            ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
            ...(input.inputChars !== undefined ? { inputChars: input.inputChars } : {}),
            ...(input.outputChars !== undefined ? { outputChars: input.outputChars } : {}),
            ...(input.promptPreview !== undefined ? { promptPreview: input.promptPreview } : {}),
            ...(input.outputPreview !== undefined ? { outputPreview: input.outputPreview } : {}),
            ...(input.error !== undefined ? { error: boundText(input.error) } : {}),
            metadata: mergeMetadata(existing.metadata, input.metadata),
        };
        this.sqlite
            .query(`
                UPDATE model_calls
                SET event_id = $eventId,
                    ts = $ts,
                    stage = $stage,
                    scope = $scope,
                    model_id = $modelId,
                    status = $status,
                    duration_ms = $durationMs,
                    input_chars = $inputChars,
                    output_chars = $outputChars,
                    prompt_preview = $promptPreview,
                    output_preview = $outputPreview,
                    error = $error,
                    metadata_json = $metadataJson
                WHERE model_call_id = $id
            `)
            .run({
                $id: record.id,
                $eventId: record.eventId ?? null,
                $ts: record.ts,
                $stage: record.stage,
                $scope: record.scope,
                $modelId: record.modelId,
                $status: record.status,
                $durationMs: record.durationMs ?? null,
                $inputChars: record.inputChars ?? null,
                $outputChars: record.outputChars ?? null,
                $promptPreview: record.promptPreview ?? null,
                $outputPreview: record.outputPreview ?? null,
                $error: record.error ?? null,
                $metadataJson: stringifyJson(record.metadata ?? null),
            });
        if (record.eventId) {
            this.updateModelCallEvent(record);
        }
        if (record.status === 'failed') {
            this.recordIncident({
                pipelineId: record.pipelineId,
                eventId: record.eventId,
                ts: record.ts,
                stage: record.stage,
                severity: 'error',
                reason: `model_call_failed:${record.scope}`,
                inputSnapshot: record.promptPreview,
                outputSnapshot: record.error,
                metadata: { modelCallId: record.id, modelId: record.modelId },
            });
        }
        this.refreshPipelineSeverity(record.pipelineId);
        return record;
    }

    private updateModelCallEvent(record: ModelCallRecord): void {
        if (!record.eventId) return;
        this.sqlite
            .query(`
                UPDATE pipeline_events
                SET ts = $ts,
                    stage = $stage,
                    level = $level,
                    title = $title,
                    message = $message,
                    timings_json = $timingsJson,
                    metadata_json = $metadataJson
                WHERE event_id = $eventId
            `)
            .run({
                $eventId: record.eventId,
                $ts: record.ts,
                $stage: record.stage,
                $level: record.status === 'failed' ? 'error' : 'info',
                $title: 'Model call reference',
                $message: null,
                $timingsJson: stringifyJson(record.durationMs !== undefined
                    ? [{ key: 'model_call', label: record.scope, durationMs: record.durationMs, detail: record.error }]
                    : null),
                $metadataJson: stringifyJson(cleanObject({
                    modelCallId: record.id,
                    scope: record.scope,
                    modelId: record.modelId,
                    status: record.status,
                    inputChars: record.inputChars ?? null,
                    outputChars: record.outputChars ?? null,
                })),
            });
    }

    recordIncident(input: IncidentInput): PipelineIncident {
        const pipelineId = resolveLogAssociationId(input.pipelineId, input.conversationId, input.metadata);
        const pipeline = this.getPipeline(pipelineId);
        const incident: PipelineIncident = {
            id: input.id ?? createId('inc'),
            pipelineId,
            ...(input.eventId ? { eventId: input.eventId } : {}),
            ts: input.ts ?? Date.now(),
            stage: input.stage,
            severity: input.severity ?? 'warn',
            reason: input.reason,
            ...(input.inputSnapshot !== undefined ? { inputSnapshot: stringifySnapshot(input.inputSnapshot) } : {}),
            ...(input.outputSnapshot !== undefined ? { outputSnapshot: stringifySnapshot(input.outputSnapshot) } : {}),
            ...(input.recommendedAction ? { recommendedAction: input.recommendedAction } : {}),
            metadata: boundedMetadata(input.metadata),
            ...(input.summary ? { summary: input.summary } : {}),
        };
        if (pipeline) {
            const event = this.appendEvent({
                pipelineId: incident.pipelineId,
                ts: incident.ts,
                stage: incident.stage,
                eventType: incident.reason.includes('repair') ? 'repair' : 'fallback',
                level: incident.severity,
                title: incident.reason,
                message: incident.recommendedAction,
                metadata: {
                    incidentId: incident.id,
                    severity: incident.severity,
                },
            });
            if (!incident.eventId) incident.eventId = event.id;
        }
        this.sqlite
            .query(`
                INSERT INTO pipeline_incidents (
                    incident_id, pipeline_id, event_id, ts, stage, severity, reason,
                    input_snapshot, output_snapshot, recommended_action, metadata_json, summary
                )
                VALUES (
                    $id, $pipelineId, $eventId, $ts, $stage, $severity, $reason,
                    $inputSnapshot, $outputSnapshot, $recommendedAction, $metadataJson, $summary
                )
            `)
            .run({
                $id: incident.id,
                $pipelineId: incident.pipelineId,
                $eventId: incident.eventId ?? null,
                $ts: incident.ts,
                $stage: incident.stage,
                $severity: incident.severity,
                $reason: incident.reason,
                $inputSnapshot: incident.inputSnapshot ?? null,
                $outputSnapshot: incident.outputSnapshot ?? null,
                $recommendedAction: incident.recommendedAction ?? null,
                $metadataJson: stringifyJson(incident.metadata ?? null),
                $summary: incident.summary ?? null,
            });
        this.refreshPipelineSeverity(incident.pipelineId);
        return incident;
    }

    completePipeline(pipelineId: string, input: CompletePipelineInput = {}): PipelineRun | null {
        const existing = this.getPipeline(pipelineId);
        if (!existing) return null;
        const completedAt = input.completedAt ?? Date.now();
        const status = input.status ?? (existing.severity === 'error' ? 'failed' : 'completed');
        const metadata = input.metadata !== undefined
            ? { ...getRecord(existing.metadata), ...getRecord(input.metadata) }
            : existing.metadata;
        this.sqlite
            .query(`
                UPDATE pipeline_runs
                SET status = $status,
                    completed_at = $completedAt,
                    duration_ms = $durationMs,
                    summary_json = COALESCE($summaryJson, summary_json),
                    metadata_json = $metadataJson
                WHERE pipeline_id = $pipelineId
            `)
            .run({
                $status: status,
                $completedAt: completedAt,
                $durationMs: Math.max(0, completedAt - existing.startedAt),
                $summaryJson: input.summary !== undefined ? stringifyJson(input.summary) : null,
                $metadataJson: stringifyJson(metadata ?? null),
                $pipelineId: pipelineId,
            });
        this.refreshPipelineSeverity(pipelineId);
        return this.getPipeline(pipelineId);
    }

    updatePipelineMetadata(pipelineId: string, metadata: unknown): PipelineRun | null {
        const existing = this.getPipeline(pipelineId);
        if (!existing) return null;
        const merged = { ...getRecord(existing.metadata), ...getRecord(metadata) };
        this.sqlite
            .query('UPDATE pipeline_runs SET metadata_json = $metadataJson WHERE pipeline_id = $pipelineId')
            .run({
                $metadataJson: stringifyJson(merged),
                $pipelineId: pipelineId,
            });
        return this.getPipeline(pipelineId);
    }

    listPipelines(options: { kind?: PipelineKind | string | null; status?: PipelineStatus | string | null; limit?: number } = {}): PipelineRun[] {
        const limit = normalizeLimit(options.limit);
        const kind = normalizeKind(options.kind);
        const status = normalizeStatus(options.status);
        const clauses: string[] = options.kind ? [] : [`kind IN ('system', 'conversation')`];
        const params: Record<string, string | number> = { $limit: limit };
        if (kind) {
            clauses.push('kind = $kind');
            params.$kind = kind;
        } else if (options.kind) {
            clauses.push('1 = 0');
        }
        if (status) {
            clauses.push('status = $status');
            params.$status = status;
        }
        const rows = this.sqlite
            .query<PipelineRunRow, Record<string, string | number>>(`
                SELECT *
                FROM pipeline_runs
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                ORDER BY started_at DESC, rowid DESC
                LIMIT $limit
            `)
            .all(params);
        return rows.map(row => this.toPipelineRun(row));
    }

    listAllPipelines(options: { limit?: number } = {}): PipelineRun[] {
        const limit = normalizeLimit(options.limit ?? 500);
        const rows = this.sqlite
            .query<PipelineRunRow, [number]>('SELECT * FROM pipeline_runs ORDER BY started_at DESC, rowid DESC LIMIT ?')
            .all(limit);
        return rows.map(row => this.toPipelineRun(row));
    }

    getPipeline(pipelineId: string): PipelineRun | null {
        const row = this.sqlite
            .query<PipelineRunRow, [string]>('SELECT * FROM pipeline_runs WHERE pipeline_id = ?')
            .get(pipelineId);
        return row ? this.toPipelineRun(row) : null;
    }

    getPipelineDetail(pipelineId: string): PipelineDetail | null {
        const run = this.getPipeline(pipelineId);
        if (!run) return null;
        return {
            ...run,
            events: this.listEvents({ pipelineId, limit: MAX_LIMIT }).reverse(),
        };
    }

    getModelCall(modelCallId: string): ModelCallRecord | null {
        const row = this.sqlite
            .query<ModelCallRow, [string]>('SELECT * FROM model_calls WHERE model_call_id = ?')
            .get(modelCallId);
        return row ? rowToModelCall(row) : null;
    }

    listEvents(options: { pipelineId?: string; stage?: PipelineStage | string | null; limit?: number } = {}): PipelineEvent[] {
        const limit = normalizeLimit(options.limit);
        const stage = normalizeStage(options.stage);
        const clauses: string[] = [];
        const params: Record<string, string | number> = { $limit: limit };
        if (options.pipelineId) {
            clauses.push('pipeline_id = $pipelineId');
            params.$pipelineId = options.pipelineId;
        }
        if (stage) {
            clauses.push('stage = $stage');
            params.$stage = stage;
        }
        const rows = this.sqlite
            .query<PipelineEventRow, Record<string, string | number>>(`
                SELECT *
                FROM pipeline_events
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
                ORDER BY ts DESC, rowid DESC
                LIMIT $limit
            `)
            .all(params);
        return rows.map(rowToEvent);
    }

    listModelCalls(options: { pipelineId?: string; limit?: number } = {}): ModelCallRecord[] {
        const limit = normalizeLimit(options.limit);
        const rows = options.pipelineId
            ? this.sqlite
                .query<ModelCallRow, [string, number]>('SELECT * FROM model_calls WHERE pipeline_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
                .all(options.pipelineId, limit)
            : this.sqlite
                .query<ModelCallRow, [number]>('SELECT * FROM model_calls ORDER BY ts DESC, rowid DESC LIMIT ?')
                .all(limit);
        return rows.map(rowToModelCall);
    }

    listIncidents(options: { pipelineId?: string; limit?: number } = {}): PipelineIncident[] {
        const limit = normalizeLimit(options.limit);
        const rows = options.pipelineId
            ? this.sqlite
                .query<IncidentRow, [string, number]>('SELECT * FROM pipeline_incidents WHERE pipeline_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
                .all(options.pipelineId, limit)
            : this.sqlite
                .query<IncidentRow, [number]>('SELECT * FROM pipeline_incidents ORDER BY ts DESC, rowid DESC LIMIT ?')
                .all(limit);
        return rows.map(rowToIncident);
    }

    getIncident(incidentId: string): PipelineIncident | null {
        const row = this.sqlite
            .query<IncidentRow, [string]>('SELECT * FROM pipeline_incidents WHERE incident_id = ?')
            .get(incidentId);
        return row ? rowToIncident(row) : null;
    }

    removePipeline(pipelineId: string): boolean {
        return this.sqlite.transaction((id: string) => {
            this.sqlite.query('DELETE FROM pipeline_incidents WHERE pipeline_id = ?').run(id);
            this.sqlite.query('DELETE FROM model_calls WHERE pipeline_id = ?').run(id);
            this.sqlite.query('DELETE FROM pipeline_events WHERE pipeline_id = ?').run(id);
            return this.sqlite.query('DELETE FROM pipeline_runs WHERE pipeline_id = ?').run(id).changes > 0;
        })(pipelineId);
    }

    removeModelCall(modelCallId: string): boolean {
        const existing = this.getModelCall(modelCallId);
        if (!existing) return false;
        const removed = this.sqlite.query('DELETE FROM model_calls WHERE model_call_id = ?').run(modelCallId).changes > 0;
        if (removed) {
            this.refreshPipelineSeverity(existing.pipelineId);
        }
        return removed;
    }

    removeIncident(incidentId: string): boolean {
        const existing = this.getIncident(incidentId);
        if (!existing) return false;
        const removed = this.sqlite.query('DELETE FROM pipeline_incidents WHERE incident_id = ?').run(incidentId).changes > 0;
        if (removed) {
            this.refreshPipelineSeverity(existing.pipelineId);
        }
        return removed;
    }

    clear(): void {
        this.sqlite.transaction(() => {
            this.sqlite.run('DELETE FROM pipeline_incidents');
            this.sqlite.run('DELETE FROM model_calls');
            this.sqlite.run('DELETE FROM pipeline_events');
            this.sqlite.run('DELETE FROM pipeline_runs');
        })();
    }

    close(): void {
        this.sqlite.close();
    }

    private init(): void {
        this.sqlite.run(`
            CREATE TABLE IF NOT EXISTS pipeline_runs (
                pipeline_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                title TEXT NOT NULL,
                conversation_id TEXT,
                user_command TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                duration_ms INTEGER,
                severity TEXT NOT NULL,
                summary_json TEXT,
                metadata_json TEXT
            )
        `);
        this.sqlite.run(`
            CREATE TABLE IF NOT EXISTS pipeline_events (
                event_id TEXT PRIMARY KEY,
                pipeline_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                stage TEXT NOT NULL,
                event_type TEXT NOT NULL,
                level TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT,
                detail TEXT,
                timings_json TEXT,
                metadata_json TEXT
            )
        `);
        this.sqlite.run(`
            CREATE TABLE IF NOT EXISTS model_calls (
                model_call_id TEXT PRIMARY KEY,
                pipeline_id TEXT NOT NULL,
                event_id TEXT,
                ts INTEGER NOT NULL,
                stage TEXT NOT NULL,
                scope TEXT NOT NULL,
                model_id TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER,
                input_chars INTEGER,
                output_chars INTEGER,
                prompt_preview TEXT,
                output_preview TEXT,
                error TEXT,
                metadata_json TEXT
            )
        `);
        this.sqlite.run(`
            CREATE TABLE IF NOT EXISTS pipeline_incidents (
                incident_id TEXT PRIMARY KEY,
                pipeline_id TEXT NOT NULL,
                event_id TEXT,
                ts INTEGER NOT NULL,
                stage TEXT NOT NULL,
                severity TEXT NOT NULL,
                reason TEXT NOT NULL,
                input_snapshot TEXT,
                output_snapshot TEXT,
                recommended_action TEXT,
                metadata_json TEXT,
                summary TEXT
            )
        `);
        this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at ON pipeline_runs (started_at)');
        this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pipeline_runs_kind ON pipeline_runs (kind)');
        this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pipeline_events_pipeline ON pipeline_events (pipeline_id, ts)');
        this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_model_calls_pipeline ON model_calls (pipeline_id, ts)');
        this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pipeline_incidents_pipeline ON pipeline_incidents (pipeline_id, ts)');
    }

    private refreshPipelineSeverity(pipelineId: string): void {
        const pipeline = this.getPipeline(pipelineId);
        if (!pipeline) return;
        const levelRow = this.sqlite
            .query<{ level: PipelineEventLevel }, [string]>('SELECT level FROM pipeline_events WHERE pipeline_id = ?')
            .all(pipelineId)
            .reduce<PipelineEventLevel>((highest, row) => LEVEL_RANK[row.level] > LEVEL_RANK[highest] ? row.level : highest, 'info');
        this.sqlite
            .query('UPDATE pipeline_runs SET severity = $severity WHERE pipeline_id = $pipelineId')
            .run({ $severity: levelRow, $pipelineId: pipelineId });
        if (pipeline.status === 'running' && levelRow === 'error') {
            this.sqlite
                .query('UPDATE pipeline_runs SET status = $status WHERE pipeline_id = $pipelineId')
                .run({ $status: 'failed', $pipelineId: pipelineId });
        }
    }

    private prune(): void {
        if (!Number.isFinite(this.maxEvents) || this.maxEvents <= 0) return;
        this.sqlite
            .query(`
                DELETE FROM pipeline_events
                WHERE event_id NOT IN (
                    SELECT event_id
                    FROM pipeline_events
                    ORDER BY ts DESC, rowid DESC
                    LIMIT $limit
                )
            `)
            .run({ $limit: Math.max(1, Math.floor(this.maxEvents)) });
    }

    private toPipelineRun(row: PipelineRunRow): PipelineRun {
        const eventCount = this.sqlite
            .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM pipeline_events WHERE pipeline_id = ?')
            .get(row.pipeline_id)?.count ?? 0;
        const incidentCount = this.sqlite
            .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM pipeline_incidents WHERE pipeline_id = ?')
            .get(row.pipeline_id)?.count ?? 0;
        const modelCallCount = this.sqlite
            .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM model_calls WHERE pipeline_id = ?')
            .get(row.pipeline_id)?.count ?? 0;
        return {
            id: row.pipeline_id,
            kind: row.kind,
            status: row.status,
            title: row.title,
            ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
            ...(row.user_command ? { userCommand: row.user_command } : {}),
            startedAt: row.started_at,
            ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
            ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
            severity: row.severity,
            ...(row.summary_json ? { summary: parseJson(row.summary_json) } : {}),
            ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}),
            eventCount,
            incidentCount,
            modelCallCount,
        };
    }
}

export const pipelineLogs = new PipelineLogService();

function resolvePipelineRunInput(input: Pick<PipelineEventInput, 'pipelineId' | 'conversationId' | 'stage' | 'title' | 'metadata'>): PipelineRunInput {
    const metadata = getRecord(input.metadata);
    const pipelineId = input.pipelineId ?? stringValue(metadata.pipelineId) ?? stringValue(metadata.pipeline_id) ?? input.conversationId ?? stringValue(metadata.conversationId) ?? stringValue(metadata.conversation_id);
    const conversationId = input.conversationId ?? stringValue(metadata.conversationId) ?? stringValue(metadata.conversation_id);
    const kind = kindFromStage(input.stage, metadata);
    return {
        id: pipelineId ?? createId('pipe'),
        kind,
        title: kind === 'system' ? 'System pipeline' : 'Conversation pipeline',
        conversationId,
        userCommand: stringValue(metadata.userCommand),
        metadata: cleanObject({
            createdBy: 'pipeline-log-service',
            sourceStage: input.stage,
            ...metadata,
        }),
    };
}

function kindFromStage(stage: PipelineStage, metadata: Record<string, unknown>): PipelineKind {
    const kind = stringValue(metadata.pipelineKind) ?? stringValue(metadata.kind);
    if (kind && ['system', 'conversation'].includes(kind)) {
        return kind as PipelineKind;
    }
    if (stage === 'service') return 'system';
    return 'conversation';
}

function normalizeWritableKind(kind: PipelineKind | string): PipelineKind {
    return kind === 'system' ? 'system' : 'conversation';
}

function resolveLogAssociationId(pipelineId?: string | null, conversationId?: string | null, metadata?: unknown): string {
    const record = getRecord(metadata);
    return pipelineId
        ?? stringValue(record.pipelineId)
        ?? stringValue(record.pipeline_id)
        ?? conversationId
        ?? stringValue(record.conversationId)
        ?? stringValue(record.conversation_id)
        ?? stringValue(record.traceId)
        ?? createId('unlinked');
}

function shouldWriteRuntimePipelineEvent(input: RuntimeLogInput): boolean {
    const conversationId = input.conversationId
        ?? stringValue(getRecord(input.metadata).conversationId)
        ?? stringValue(getRecord(input.metadata).conversation_id);
    if (input.category === 'system') return input.title.startsWith('system.') || Boolean(conversationId);
    if (input.category === 'dashboard-service') return true;
    return Boolean(conversationId);
}

function normalizeRuntimeTitle(input: RuntimeLogInput): string {
    if (input.category === 'system') return 'system.ready';
    if (input.category === 'dashboard-service') return 'system.component_ready';
    return input.title;
}

function rowToEvent(row: PipelineEventRow): PipelineEvent {
    return {
        id: row.event_id,
        pipelineId: row.pipeline_id,
        ts: row.ts,
        stage: row.stage,
        eventType: row.event_type,
        level: row.level,
        title: row.title,
        ...(row.message !== null ? { message: row.message } : {}),
        ...(row.detail !== null ? { detail: row.detail } : {}),
        ...(row.timings_json ? { timings: parseJson(row.timings_json) as TaskTiming[] } : {}),
        ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}),
    };
}

function rowToModelCall(row: ModelCallRow): ModelCallRecord {
    return {
        id: row.model_call_id,
        pipelineId: row.pipeline_id,
        ...(row.event_id ? { eventId: row.event_id } : {}),
        ts: row.ts,
        stage: row.stage,
        scope: row.scope,
        modelId: row.model_id,
        status: row.status,
        ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
        ...(row.input_chars !== null ? { inputChars: row.input_chars } : {}),
        ...(row.output_chars !== null ? { outputChars: row.output_chars } : {}),
        ...(row.prompt_preview !== null ? { promptPreview: row.prompt_preview } : {}),
        ...(row.output_preview !== null ? { outputPreview: row.output_preview } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
        ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}),
    };
}

function rowToIncident(row: IncidentRow): PipelineIncident {
    return {
        id: row.incident_id,
        pipelineId: row.pipeline_id,
        ...(row.event_id ? { eventId: row.event_id } : {}),
        ts: row.ts,
        stage: row.stage,
        severity: row.severity,
        reason: row.reason,
        ...(row.input_snapshot !== null ? { inputSnapshot: row.input_snapshot } : {}),
        ...(row.output_snapshot !== null ? { outputSnapshot: row.output_snapshot } : {}),
        ...(row.recommended_action !== null ? { recommendedAction: row.recommended_action } : {}),
        ...(row.metadata_json ? { metadata: parseJson(row.metadata_json) } : {}),
        ...(row.summary !== null ? { summary: row.summary } : {}),
    };
}

function stageFromRuntimeCategory(category: string | undefined, title: string): PipelineStage {
    if (category === 'wake') return 'wake';
    if (category === 'voice-tts') return 'tts';
    if (category === 'voice-material') return 'summary';
    if (category === 'asr') return 'asr';
    if (category === 'model') return 'model';
    if (category === 'dashboard-service') return 'service';
    if (category === 'system') {
        const lower = title.toLowerCase();
        if (lower.includes('intent')) return 'intent';
        if (lower.includes('tts')) return 'tts';
        if (lower.includes('asr')) return 'asr';
        if (lower.includes('memory')) return 'memory';
        if (lower.includes('vision')) return 'vision';
    }
    return 'summary';
}

function eventTypeFromLevel(level: PipelineEventLevel): PipelineEventType {
    if (level === 'error') return 'stage_failed';
    if (level === 'warn') return 'fallback';
    return 'stage_complete';
}

function normalizeLimit(limit: number | null | undefined): number {
    return Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(Number(limit)) : DEFAULT_LIMIT, MAX_LIMIT));
}

function normalizeKind(kind: PipelineKind | string | null | undefined): PipelineKind | null {
    if (!kind) return null;
    return ['system', 'conversation'].includes(kind) ? kind as PipelineKind : null;
}

function normalizeStatus(status: PipelineStatus | string | null | undefined): PipelineStatus | null {
    if (!status) return null;
    return ['running', 'completed', 'failed'].includes(status) ? status as PipelineStatus : null;
}

function normalizeStage(stage: PipelineStage | string | null | undefined): PipelineStage | null {
    if (!stage) return null;
    return ['wake', 'asr', 'intent', 'context', 'memory', 'vision', 'model', 'tool', 'tts', 'service', 'summary'].includes(stage) ? stage as PipelineStage : null;
}

function stringifyJson(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    return JSON.stringify(value);
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function getRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

function createId(prefix: string): string {
    return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function stringifySnapshot(value: unknown): string {
    if (typeof value === 'string') return boundText(value);
    return boundText(JSON.stringify(value ?? null, null, 2));
}

function boundedMetadata(value: unknown): unknown {
    const record = cleanObject(boundMetadataValue(getRecord(value)) as Record<string, unknown>);
    if (Object.keys(record).length === 0) return undefined;
    return record;
}

function mergeMetadata(existing: unknown, next: unknown): unknown {
    return boundedMetadata({
        ...getRecord(existing),
        ...getRecord(next),
    });
}

function boundMetadataValue(value: unknown, depth = 0): unknown {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string') return boundText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
        if (depth >= 4) return `[array depth limit:${value.length}]`;
        const maxItems = 50;
        const items = value
            .slice(0, maxItems)
            .map(item => boundMetadataValue(item, depth + 1))
            .filter(item => item !== undefined);
        if (value.length > maxItems) {
            items.push(`[truncated ${value.length - maxItems} items]`);
        }
        return items;
    }
    if (typeof value === 'object') {
        if (depth >= 4) return '[object depth limit]';
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const bounded = boundMetadataValue(item, depth + 1);
            if (bounded !== undefined) output[key] = bounded;
        }
        return output;
    }
    return String(value);
}

function boundText(value: string): string {
    const maxChars = GLOBAL_CONFIG.OLLAMA.TRACE_MAX_CHARS;
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined || item === null || item === '') continue;
        output[key] = item;
    }
    return output;
}
