import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createOllama } from 'ollama-ai-provider';
import { generateText } from 'ai';
import { GLOBAL_CONFIG } from '@/global_config';
import { getIntentionSystemPrompt } from '@server/prompts';

const DB_DIR = join(process.cwd(), 'src', 'server', 'db');
const SQLITE_RECALL_LOG_DB_PATH = process.env.NODE_ENV === 'test'
  ? join(tmpdir(), 'home-assistant-model-recall-logs-test.sqlite')
  : join(DB_DIR, 'model-recall-logs.sqlite');

type SqlValue = string | number | null;

type ModelRecallLogRow = {
  log_id: string;
  stage: ModelRecallStage;
  reason: string;
  severity: ModelRecallSeverity;
  user_command: string;
  prompt_snapshot: string;
  state_json: string;
  summary: string | null;
  created_at: number;
};

export type ModelRecallStage = 'intention' | 'response' | 'vision' | 'memory_prune';
export type ModelRecallSeverity = 'info' | 'warn' | 'error';

export type SaveModelRecallLogInput = {
  stage: ModelRecallStage;
  reason: string;
  severity?: ModelRecallSeverity;
  userCommand?: string;
  promptSnapshot?: unknown;
  state?: unknown;
};

export type ModelRecallLogRecord = {
  id: string;
  stage: ModelRecallStage;
  reason: string;
  severity: ModelRecallSeverity;
  userCommand: string;
  promptSnapshot: string;
  state: unknown;
  summary: string | null;
  createdAt: number;
};

const ollama = createOllama({
  baseURL: GLOBAL_CONFIG.OLLAMA.IP,
});

const textModel = ollama(GLOBAL_CONFIG.OLLAMA.TEXT_MODEL, {
  numCtx: GLOBAL_CONFIG.OLLAMA.TEXT_NUM_CTX,
});

export class ModelRecallLogService {
  private readonly sqlite: Database;

  constructor(dbPath = SQLITE_RECALL_LOG_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.run('PRAGMA journal_mode = WAL');
    this.init();
  }

  save(input: SaveModelRecallLogInput): ModelRecallLogRecord {
    const logId = createId();
    const createdAt = Date.now();
    this.sqlite
      .query(`
        INSERT INTO model_recall_logs (
          log_id, stage, reason, severity, user_command, prompt_snapshot, state_json, summary, created_at
        )
        VALUES (
          $logId, $stage, $reason, $severity, $userCommand, $promptSnapshot, $stateJson, NULL, $createdAt
        )
      `)
      .run({
        $logId: logId,
        $stage: input.stage,
        $reason: input.reason,
        $severity: input.severity ?? 'warn',
        $userCommand: input.userCommand ?? '',
        $promptSnapshot: stringifyPrompt(input.promptSnapshot),
        $stateJson: stringifyState(input.state ?? {}),
        $createdAt: createdAt,
      });

    return this.get(logId)!;
  }

  list(limit = 100, offset = 0): ModelRecallLogRecord[] {
    const rows = this.sqlite
      .query<ModelRecallLogRow, Record<string, SqlValue>>(`
        SELECT *
        FROM model_recall_logs
        ORDER BY created_at DESC, log_id DESC
        LIMIT $limit OFFSET $offset
      `)
      .all({
        $limit: normalizeLimit(limit),
        $offset: normalizeOffset(offset),
      });
    return rows.map(row => this.toRecord(row));
  }

  count(): number {
    const row = this.sqlite
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM model_recall_logs')
      .get();
    return row?.count ?? 0;
  }

  get(logId: string): ModelRecallLogRecord | null {
    const row = this.sqlite
      .query<ModelRecallLogRow, [string]>('SELECT * FROM model_recall_logs WHERE log_id = ?')
      .get(logId);
    return row ? this.toRecord(row) : null;
  }

  remove(logId: string): boolean {
    return this.sqlite.query('DELETE FROM model_recall_logs WHERE log_id = ?').run(logId).changes > 0;
  }

  async summarize(logId: string, language: 'zh' | 'en' = 'zh'): Promise<ModelRecallLogRecord | null> {
    const record = this.get(logId);
    if (!record) return null;

    const prompt = buildSummaryPrompt(record, language);
    const result = await generateText({
      model: textModel as any,
      maxTokens: 900,
      temperature: 0.2,
      topP: GLOBAL_CONFIG.OLLAMA.TEXT_TOP_P,
      prompt,
    });
    const summary = result.text.trim();
    this.sqlite
      .query('UPDATE model_recall_logs SET summary = $summary WHERE log_id = $logId')
      .run({ $summary: summary, $logId: logId });
    return this.get(logId);
  }

  close(): void {
    this.sqlite.close();
  }

  private init(): void {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS model_recall_logs (
        log_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        reason TEXT NOT NULL,
        severity TEXT NOT NULL,
        user_command TEXT NOT NULL,
        prompt_snapshot TEXT NOT NULL,
        state_json TEXT NOT NULL,
        summary TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_model_recall_logs_created_at ON model_recall_logs (created_at)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_model_recall_logs_stage ON model_recall_logs (stage)');
  }

  private toRecord(row: ModelRecallLogRow): ModelRecallLogRecord {
    return {
      id: row.log_id,
      stage: row.stage,
      reason: row.reason,
      severity: row.severity,
      userCommand: row.user_command,
      promptSnapshot: row.prompt_snapshot,
      state: parseState(row.state_json),
      summary: row.summary,
      createdAt: row.created_at,
    };
  }
}

export const modelRecallLogs = new ModelRecallLogService();

function buildSummaryPrompt(record: ModelRecallLogRecord, language: 'zh' | 'en'): string {
  const systemPrompt = record.stage === 'intention'
    ? getIntentionSystemPrompt(language)
    : '';
  if (language === 'en') {
    return `You are reviewing a model recall/fallback incident in a home assistant.

Incident:
${JSON.stringify(record, null, 2)}

Current prompt at the failed stage:
${systemPrompt || record.promptSnapshot}

Please provide:
1. Most likely cause of the recall.
2. Which field, instruction, or context failed.
3. Minimal prompt modification suggestions.
4. Any implementation guard that would prevent recurrence.

Be concrete and concise.`;
  }

  return `你正在复盘一个家庭助手里的模型召回/fallback 事件。

事件现场：
${JSON.stringify(record, null, 2)}

出错环节当前已有提示词：
${systemPrompt || record.promptSnapshot}

请给出：
1. 最可能触发召回的原因。
2. 具体是哪个字段、指令或上下文出了问题。
3. 最小化的提示词修改建议。
4. 可选的工程防护建议，避免同类问题再次发生。

请具体、简洁，不要泛泛而谈。`;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 100, 500));
}

function normalizeOffset(offset: number): number {
  return Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
}

function stringifyPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? '', null, 2);
}

function stringifyState(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseState(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
