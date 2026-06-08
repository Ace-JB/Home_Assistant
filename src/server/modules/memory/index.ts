import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getDataDbDir } from '@/server/services/runtime-paths';

const DB_DIR = getDataDbDir();
const SQLITE_MEMORY_DB_PATH = join(DB_DIR, 'memory.sqlite');
const MEMORY_HEAT_DECAY_GAMMA = 1.2;
const MEMORY_HEAT_SCORE_CAP = 8;
const MEMORY_COLD_HEAT_MULTIPLIER = 0.4;
const MEMORY_COLD_AFTER_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SEMANTIC_TERM_SCORE = 3;
const MIN_CONTEXT_SEMANTIC_SCORE = SEMANTIC_TERM_SCORE;
const TOKEN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'for',
  'how',
  'please',
  'the',
  'this',
  'that',
  'to',
  'turn',
  'what',
  'with',
  'you',
  'your',
]);

type SqlValue = string | number | null;

type ConversationSessionRow = {
  conversation_id: string;
  messages: string;
  created_at: string;
  updated_at: string;
};

type PrunedMemoryRow = {
  memory_id: string;
  source_conversation_id: string;
  content: string;
  base_score: number;
  hit_count: number;
  created_at: number;
  last_accessed_at: number;
  status: 'warm' | 'cold';
  topic: string;
  user_state: string;
  behavior_signal: string;
  interaction_result: string;
  location: MemoryLocation;
  time_bucket: TimeBucket;
  day_type: DayType;
};

type MemoryCandidateRow = {
  candidate_id: string;
  source_conversation_id: string;
  draft_json: string;
  score: number;
  status: MemoryCandidateStatus;
  created_at: number;
  reviewed_at: number | null;
};

type MemoryScore = {
  semanticScore: number;
  situationScore: number;
  heatScore: number;
  totalScore: number;
};

export type ConversationRole = 'user' | 'agent';
export type MemoryStatus = 'warm' | 'cold';
export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected';
export type MemoryLocation = 'living_room' | 'bedroom' | 'kitchen' | 'unknown';
export type TimeBucket = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';
export type DayType = 'weekday' | 'weekend';

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface ConversationSessionRecord {
  conversationId: string;
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  sourceConversationId: string;
  content: string;
  baseScore: number;
  hitCount: number;
  createdAt: number;
  lastAccessedAt: number;
  status: MemoryStatus;
  topic: string;
  userState: string;
  behaviorSignal: string;
  interactionResult: string;
  location: MemoryLocation;
  timeBucket: TimeBucket;
  dayType: DayType;
}

export type PrunedMemoryRecord = MemoryRecord;

export interface MemoryCandidateRecord {
  id: string;
  sourceConversationId: string;
  draftJson: string;
  score: number;
  status: MemoryCandidateStatus;
  createdAt: number;
  reviewedAt: number | null;
}

export interface CreateConversationSessionInput {
  conversation_id?: string;
  created_at?: string;
}

export interface AppendConversationTurnInput {
  conversation_id: string;
  user_content: string;
  agent_content: string;
  created_at?: string;
}

export interface ConversationSearchOptions {
  conversationId?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SavePrunedMemoryInput {
  source_conversation_id: string;
  content: string;
  base_score?: number;
  status?: MemoryStatus;
  topic?: string;
  user_state?: string;
  behavior_signal?: string;
  interaction_result?: string;
  created_at?: number;
  location?: MemoryLocation;
}

export interface UpdatePrunedMemoryInput {
  memory_id: string;
  content: string;
  base_score?: number;
  status?: MemoryStatus;
  topic?: string;
  user_state?: string;
  behavior_signal?: string;
  interaction_result?: string;
  location?: MemoryLocation;
}

export interface PrunedMemorySearchOptions {
  sourceConversationId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface SaveMemoryCandidateInput {
  source_conversation_id: string;
  draft_json: string;
  score?: number;
  status?: MemoryCandidateStatus;
  created_at?: number;
}

export interface MemoryCandidateSearchOptions {
  sourceConversationId?: string;
  status?: MemoryCandidateStatus;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ContextMemorySearchOptions {
  query: string;
  location?: MemoryLocation;
  timeBucket?: TimeBucket;
  dayType?: DayType;
  limit?: number;
  mode?: 'semantic' | 'recent_recall' | 'hybrid';
}

export interface RecentConversationMessageOptions {
  conversationId: string;
  limit?: number;
}

export class MemoryDatabase {
  private readonly sqlite: Database;
  private hasMemoryFts = false;

  constructor(dbPath = SQLITE_MEMORY_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.run('PRAGMA journal_mode = WAL');
    this.sqlite.run('PRAGMA foreign_keys = ON');
    this.init();
  }

  createConversationSession(input: CreateConversationSessionInput = {}): ConversationSessionRecord {
    const conversationId = input.conversation_id ?? createId();
    const now = new Date().toISOString();
    const createdAt = input.created_at ?? now;

    this.sqlite
      .query(`
        INSERT INTO conversations (conversation_id, messages, created_at, updated_at)
        VALUES ($conversationId, $messages, $createdAt, $updatedAt)
      `)
      .run({
        $conversationId: conversationId,
        $messages: JSON.stringify([]),
        $createdAt: createdAt,
        $updatedAt: createdAt,
      });

    return this.getConversationSession(conversationId)!;
  }

  appendConversationTurn(input: AppendConversationTurnInput): ConversationSessionRecord {
    const existing = this.getConversationSession(input.conversation_id)
      ?? this.createConversationSession({ conversation_id: input.conversation_id, created_at: input.created_at });
    const messageCreatedAt = input.created_at ?? new Date().toISOString();
    const messages: ConversationMessage[] = [
      ...existing.messages,
      { role: 'user', content: input.user_content, createdAt: messageCreatedAt },
      { role: 'agent', content: input.agent_content, createdAt: messageCreatedAt },
    ];

    this.sqlite
      .query(`
        UPDATE conversations
        SET messages = $messages,
            updated_at = $updatedAt
        WHERE conversation_id = $conversationId
      `)
      .run({
        $conversationId: input.conversation_id,
        $messages: JSON.stringify(messages),
        $updatedAt: messageCreatedAt,
      });

    return this.getConversationSession(input.conversation_id)!;
  }

  getConversationSession(conversationId: string): ConversationSessionRecord | null {
    const row = this.sqlite
      .query<ConversationSessionRow, [string]>(`
        SELECT conversation_id, messages, created_at, updated_at
        FROM conversations
        WHERE conversation_id = ?
      `)
      .get(conversationId);
    return row ? this.toSessionRecord(row) : null;
  }

  searchConversationSessions(options: ConversationSearchOptions = {}): ConversationSessionRecord[] {
    const { where, params } = this.buildConversationWhere(options);
    const rows = this.sqlite
      .query<ConversationSessionRow, Record<string, SqlValue>>(`
        SELECT conversation_id, messages, created_at, updated_at
        FROM conversations
        ${where}
        ORDER BY updated_at DESC, conversation_id DESC
        LIMIT $limit OFFSET $offset
      `)
      .all({
        ...params,
        $limit: normalizeLimit(options.limit),
        $offset: normalizeOffset(options.offset),
      });
    return rows.map(row => this.toSessionRecord(row));
  }

  getRecentConversationMessages(options: RecentConversationMessageOptions): ConversationMessage[] {
    const session = this.getConversationSession(options.conversationId);
    if (!session) return [];
    const limit = normalizeLimit(options.limit);
    return session.messages.slice(-limit);
  }

  countConversationSessions(options: Omit<ConversationSearchOptions, 'limit' | 'offset'> = {}): number {
    const { where, params } = this.buildConversationWhere(options);
    const row = this.sqlite
      .query<{ count: number }, Record<string, SqlValue>>(`SELECT COUNT(*) AS count FROM conversations ${where}`)
      .get(params);
    return row?.count ?? 0;
  }

  removeConversationSession(conversationId: string): boolean {
    return this.sqlite.query('DELETE FROM conversations WHERE conversation_id = ?').run(conversationId).changes > 0;
  }

  savePrunedMemory(input: SavePrunedMemoryInput): MemoryRecord {
    const existing = this.searchPrunedMemories({ sourceConversationId: input.source_conversation_id, limit: 1 })[0];
    if (existing) {
      return this.updatePrunedMemory({
        memory_id: existing.id,
        content: input.content,
        base_score: input.base_score,
        status: input.status,
        topic: input.topic,
        user_state: input.user_state,
        behavior_signal: input.behavior_signal,
        interaction_result: input.interaction_result,
        location: input.location,
      })!;
    }

    const now = input.created_at ?? Date.now();
    const createdDate = new Date(now);
    const memoryId = createId();
    const baseScore = normalizeBaseScore(input.base_score);

    this.sqlite
      .query(`
        INSERT INTO pruned_memories (
          memory_id, source_conversation_id, content, base_score, hit_count, created_at,
          last_accessed_at, status, topic, user_state, behavior_signal, interaction_result,
          location, time_bucket, day_type
        )
        VALUES (
          $memoryId, $sourceConversationId, $content, $baseScore, 0, $createdAt,
          $lastAccessedAt, $status, $topic, $userState, $behaviorSignal, $interactionResult,
          $location, $timeBucket, $dayType
        )
      `)
      .run({
        $memoryId: memoryId,
        $sourceConversationId: input.source_conversation_id,
        $content: input.content,
        $baseScore: baseScore,
        $createdAt: now,
        $lastAccessedAt: now,
        $status: input.status ?? 'warm',
        $topic: input.topic ?? '',
        $userState: input.user_state ?? '',
        $behaviorSignal: input.behavior_signal ?? '',
        $interactionResult: input.interaction_result ?? '',
        $location: input.location ?? 'unknown',
        $timeBucket: getTimeBucket(createdDate),
        $dayType: getDayType(createdDate),
      });

    const memory = this.getPrunedMemory(memoryId)!;
    this.upsertPrunedMemoryFts(memory);
    return memory;
  }

  getPrunedMemory(memoryId: string): MemoryRecord | null {
    const row = this.sqlite
      .query<PrunedMemoryRow, [string]>(`
        SELECT *
        FROM pruned_memories
        WHERE memory_id = ?
      `)
      .get(memoryId);
    return row ? this.toMemoryRecord(row) : null;
  }

  updatePrunedMemory(input: UpdatePrunedMemoryInput): MemoryRecord | null {
    const existing = this.getPrunedMemory(input.memory_id);
    if (!existing) return null;
    const updatedAt = Date.now();
    const baseScore = input.base_score === undefined ? existing.baseScore : normalizeBaseScore(input.base_score);

    this.sqlite
      .query(`
        UPDATE pruned_memories
        SET content = $content,
            base_score = $baseScore,
            status = $status,
            topic = $topic,
            user_state = $userState,
            behavior_signal = $behaviorSignal,
            interaction_result = $interactionResult,
            location = $location
        WHERE memory_id = $memoryId
      `)
      .run({
        $memoryId: input.memory_id,
        $content: input.content,
        $baseScore: baseScore,
        $status: input.status ?? existing.status,
        $topic: input.topic ?? existing.topic,
        $userState: input.user_state ?? existing.userState,
        $behaviorSignal: input.behavior_signal ?? existing.behaviorSignal,
        $interactionResult: input.interaction_result ?? existing.interactionResult,
        $location: input.location ?? existing.location,
      });

    this.touchMemory(input.memory_id, updatedAt, false);
    const memory = this.getPrunedMemory(input.memory_id);
    if (memory) {
      this.upsertPrunedMemoryFts(memory);
    }
    return memory;
  }

  removePrunedMemory(memoryId: string): boolean {
    const removed = this.sqlite.query('DELETE FROM pruned_memories WHERE memory_id = ?').run(memoryId).changes > 0;
    if (removed) {
      this.deletePrunedMemoryFts(memoryId);
    }
    return removed;
  }

  searchPrunedMemories(options: PrunedMemorySearchOptions = {}): MemoryRecord[] {
    const { where, params } = this.buildMemoryWhere(options);
    const rows = this.sqlite
      .query<PrunedMemoryRow, Record<string, SqlValue>>(`
        SELECT *
        FROM pruned_memories
        ${where}
        ORDER BY last_accessed_at DESC, created_at DESC, memory_id DESC
        LIMIT $limit OFFSET $offset
      `)
      .all({
        ...params,
        $limit: normalizeLimit(options.limit),
        $offset: normalizeOffset(options.offset),
      });
    return rows.map(row => this.toMemoryRecord(row));
  }

  getContextMemories(optionsOrQuery: ContextMemorySearchOptions | string, limit = 5): MemoryRecord[] {
    const options: ContextMemorySearchOptions = typeof optionsOrQuery === 'string'
      ? { query: optionsOrQuery, limit }
      : optionsOrQuery;
    const mode = options.mode ?? 'semantic';
    if (mode === 'recent_recall') {
      return this.getRecentContextMemories(normalizeLimit(options.limit), options.query, new Set(), true);
    }

    const terms = tokenize(options.query);
    if (terms.length === 0) {
      traceContextMemorySearch(options.query, 0, [], mode, 'no_terms');
      return [];
    }

    const candidates = this.searchContextMemoryCandidates(terms, false);
    const scored = candidates
      .map(memory => ({
        memory,
        score: scoreMemory(memory, terms, options),
      }))
      .filter(item => item.score.semanticScore >= MIN_CONTEXT_SEMANTIC_SCORE)
      .sort((a, b) => b.score.totalScore - a.score.totalScore)
      .slice(0, normalizeLimit(options.limit));

    let finalScored = scored;
    if (mode === 'hybrid' && scored.length < normalizeLimit(options.limit)) {
      const remaining = this.getRecentContextMemories(normalizeLimit(options.limit) - scored.length, options.query, new Set(scored.map(item => item.memory.id)));
      finalScored = [
        ...scored,
        ...remaining.map(memory => ({
          memory,
          score: {
            semanticScore: 0,
            situationScore: 0,
            heatScore: calculateHeat(memory, Date.now()),
            totalScore: calculateHeat(memory, Date.now()),
          },
        })),
      ];
    }

    const reason = finalScored.length > 0
      ? undefined
      : this.getPendingMemoryCandidateMatchCount(terms) > 0
        ? 'candidate_pending'
        : this.searchContextMemoryCandidates(terms, true).some(item => item.status === 'cold')
          ? 'cold_filtered'
          : 'below_semantic_threshold';
    traceContextMemorySearch(options.query, candidates.length, finalScored, mode, reason);

    const results = finalScored.map(item => item.memory);
    for (const item of results) {
      this.touchMemory(item.id, Date.now(), true);
    }
    return results.map(item => this.getPrunedMemory(item.id) ?? item);
  }

  getRecentContextMemories(limit = 5, query = '', excludeIds: Set<string> = new Set(), includeCold = false): MemoryRecord[] {
    const rows = this.sqlite
      .query<PrunedMemoryRow, Record<string, SqlValue>>(`
        SELECT *
        FROM pruned_memories
        ${includeCold ? '' : 'WHERE status = $status'}
        ORDER BY created_at DESC, last_accessed_at DESC, memory_id DESC
        LIMIT $limit
      `)
      .all({
        ...(includeCold ? {} : { $status: 'warm' }),
        $limit: normalizeLimit(limit + excludeIds.size),
      });
    const results = rows
      .map(row => this.toMemoryRecord(row))
      .filter(item => !excludeIds.has(item.id))
      .slice(0, normalizeLimit(limit));

    traceRecentMemorySearch(query, rows.length, results);
    for (const item of results) {
      this.touchMemory(item.id, Date.now(), true);
    }
    return results.map(item => this.getPrunedMemory(item.id) ?? item);
  }

  saveMemoryCandidate(input: SaveMemoryCandidateInput): MemoryCandidateRecord {
    const existing = this.searchMemoryCandidates({ sourceConversationId: input.source_conversation_id, limit: 1 })[0];
    const now = input.created_at ?? Date.now();
    const score = normalizeBaseScore(input.score);
    if (existing) {
      this.sqlite
        .query(`
          UPDATE memory_candidates
          SET draft_json = $draftJson,
              score = $score,
              status = $status,
              reviewed_at = $reviewedAt
          WHERE candidate_id = $candidateId
        `)
        .run({
          $candidateId: existing.id,
          $draftJson: input.draft_json,
          $score: score,
          $status: input.status ?? (existing.status === 'pending' ? 'pending' : existing.status),
          $reviewedAt: input.status === 'pending' || input.status === undefined ? existing.reviewedAt : now,
        });
      return this.getMemoryCandidate(existing.id)!;
    }

    const candidateId = createId();
    this.sqlite
      .query(`
        INSERT INTO memory_candidates (
          candidate_id, source_conversation_id, draft_json, score, status, created_at, reviewed_at
        )
        VALUES (
          $candidateId, $sourceConversationId, $draftJson, $score, $status, $createdAt, $reviewedAt
        )
      `)
      .run({
        $candidateId: candidateId,
        $sourceConversationId: input.source_conversation_id,
        $draftJson: input.draft_json,
        $score: score,
        $status: input.status ?? 'pending',
        $createdAt: now,
        $reviewedAt: input.status && input.status !== 'pending' ? now : null,
      });

    return this.getMemoryCandidate(candidateId)!;
  }

  getMemoryCandidate(candidateId: string): MemoryCandidateRecord | null {
    const row = this.sqlite
      .query<MemoryCandidateRow, [string]>(`
        SELECT *
        FROM memory_candidates
        WHERE candidate_id = ?
      `)
      .get(candidateId);
    return row ? this.toMemoryCandidateRecord(row) : null;
  }

  searchMemoryCandidates(options: MemoryCandidateSearchOptions = {}): MemoryCandidateRecord[] {
    const { where, params } = this.buildMemoryCandidateWhere(options);
    const rows = this.sqlite
      .query<MemoryCandidateRow, Record<string, SqlValue>>(`
        SELECT *
        FROM memory_candidates
        ${where}
        ORDER BY created_at DESC, candidate_id DESC
        LIMIT $limit OFFSET $offset
      `)
      .all({
        ...params,
        $limit: normalizeLimit(options.limit),
        $offset: normalizeOffset(options.offset),
      });
    return rows.map(row => this.toMemoryCandidateRecord(row));
  }

  approveMemoryCandidate(
    candidateId: string,
    draft: Omit<SavePrunedMemoryInput, 'source_conversation_id'>,
  ): MemoryRecord | null {
    const candidate = this.getMemoryCandidate(candidateId);
    if (!candidate) return null;
    const prunedMemory = this.savePrunedMemory({
      source_conversation_id: candidate.sourceConversationId,
      ...draft,
    });
    this.updateMemoryCandidateStatus(candidateId, 'approved');
    return prunedMemory;
  }

  rejectMemoryCandidate(candidateId: string): MemoryCandidateRecord | null {
    return this.updateMemoryCandidateStatus(candidateId, 'rejected');
  }

  maintainMemoryLifecycle(now = Date.now()): number {
    const coldBefore = now - MEMORY_COLD_AFTER_DAYS * MS_PER_DAY;
    return this.sqlite
      .query(`
        UPDATE pruned_memories
        SET status = 'cold'
        WHERE status = 'warm'
          AND base_score <= 2
          AND hit_count <= 1
          AND last_accessed_at < $coldBefore
      `)
      .run({ $coldBefore: coldBefore }).changes;
  }

  close(): void {
    this.sqlite.close();
  }

  private init(): void {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations (created_at)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations (updated_at)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_conversations_messages ON conversations (messages)');

    this.ensurePrunedMemoriesSchema();
    this.ensureMemoryCandidatesSchema();
    this.removeEmptyConversationSessions();
  }

  private ensurePrunedMemoriesSchema(): void {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS pruned_memories (
        memory_id TEXT PRIMARY KEY,
        source_conversation_id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        base_score INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        topic TEXT NOT NULL,
        user_state TEXT NOT NULL,
        behavior_signal TEXT NOT NULL,
        interaction_result TEXT NOT NULL,
        location TEXT NOT NULL,
        time_bucket TEXT NOT NULL,
        day_type TEXT NOT NULL
      )
    `);
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pruned_memories_source_conversation_id ON pruned_memories (source_conversation_id)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pruned_memories_topic ON pruned_memories (topic)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pruned_memories_status ON pruned_memories (status)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pruned_memories_situation ON pruned_memories (location, time_bucket, day_type)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_pruned_memories_content ON pruned_memories (content)');
    this.ensurePrunedMemoriesFts();
  }

  private ensureMemoryCandidatesSchema(): void {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS memory_candidates (
        candidate_id TEXT PRIMARY KEY,
        source_conversation_id TEXT NOT NULL UNIQUE,
        draft_json TEXT NOT NULL,
        score INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER
      )
    `);
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_memory_candidates_source_conversation_id ON memory_candidates (source_conversation_id)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates (status)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_memory_candidates_created_at ON memory_candidates (created_at)');
  }

  private ensurePrunedMemoriesFts(): void {
    try {
      this.sqlite.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS pruned_memories_fts USING fts5(
          memory_id UNINDEXED,
          content,
          topic,
          user_state,
          behavior_signal,
          interaction_result
        )
      `);
      this.sqlite.run('DELETE FROM pruned_memories_fts');
      this.sqlite.run(`
        INSERT INTO pruned_memories_fts (
          memory_id, content, topic, user_state, behavior_signal, interaction_result
        )
        SELECT memory_id, content, topic, user_state, behavior_signal, interaction_result
        FROM pruned_memories
      `);
      this.hasMemoryFts = true;
    } catch (error) {
      this.hasMemoryFts = false;
      console.log(`[Memory] FTS unavailable, falling back to LIKE search: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildConversationWhere(options: Omit<ConversationSearchOptions, 'limit' | 'offset'>): {
    where: string;
    params: Record<string, SqlValue>;
  } {
    const clauses: string[] = ['messages != $emptyMessages'];
    const params: Record<string, SqlValue> = {};
    params.$emptyMessages = '[]';
    if (options.conversationId) {
      clauses.push('conversation_id = $conversationId');
      params.$conversationId = options.conversationId;
    }
    const query = options.query?.trim();
    if (query) {
      clauses.push('messages LIKE $query ESCAPE \'\\\'');
      params.$query = `%${escapeLike(query)}%`;
    }
    if (options.from) {
      clauses.push('created_at >= $from');
      params.$from = options.from;
    }
    if (options.to) {
      clauses.push('created_at <= $to');
      params.$to = options.to;
    }
    return { where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  private removeEmptyConversationSessions(): void {
    this.sqlite.query('DELETE FROM conversations WHERE messages = ?').run('[]');
  }

  private buildMemoryWhere(options: Omit<PrunedMemorySearchOptions, 'limit' | 'offset'>): {
    where: string;
    params: Record<string, SqlValue>;
  } {
    const clauses: string[] = [];
    const params: Record<string, SqlValue> = {};
    if (options.sourceConversationId) {
      clauses.push('source_conversation_id = $sourceConversationId');
      params.$sourceConversationId = options.sourceConversationId;
    }
    const query = options.query?.trim();
    if (query) {
      clauses.push(`(
        content LIKE $query ESCAPE '\\'
        OR topic LIKE $query ESCAPE '\\'
        OR user_state LIKE $query ESCAPE '\\'
        OR behavior_signal LIKE $query ESCAPE '\\'
        OR interaction_result LIKE $query ESCAPE '\\'
      )`);
      params.$query = `%${escapeLike(query)}%`;
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private buildMemoryCandidateWhere(options: Omit<MemoryCandidateSearchOptions, 'limit' | 'offset'>): {
    where: string;
    params: Record<string, SqlValue>;
  } {
    const clauses: string[] = [];
    const params: Record<string, SqlValue> = {};
    if (options.sourceConversationId) {
      clauses.push('source_conversation_id = $sourceConversationId');
      params.$sourceConversationId = options.sourceConversationId;
    }
    if (options.status) {
      clauses.push('status = $status');
      params.$status = options.status;
    }
    const query = options.query?.trim();
    if (query) {
      clauses.push('draft_json LIKE $query ESCAPE \'\\\'');
      params.$query = `%${escapeLike(query)}%`;
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  private searchContextMemoryCandidates(terms: string[], includeCold: boolean): MemoryRecord[] {
    const byId = new Map<string, MemoryRecord>();
    if (this.hasMemoryFts) {
      for (const memory of this.searchContextMemoryCandidatesByFts(terms, includeCold)) {
        byId.set(memory.id, memory);
      }
    }
    for (const memory of this.searchContextMemoryCandidatesByLike(terms, includeCold)) {
      byId.set(memory.id, memory);
    }
    return Array.from(byId.values());
  }

  private searchContextMemoryCandidatesByFts(terms: string[], includeCold: boolean): MemoryRecord[] {
    const ftsQuery = toFtsQuery(terms);
    if (!ftsQuery) return [];
    try {
      const rows = this.sqlite
        .query<PrunedMemoryRow, Record<string, SqlValue>>(`
          SELECT p.*
          FROM pruned_memories p
          JOIN pruned_memories_fts f ON p.memory_id = f.memory_id
          WHERE pruned_memories_fts MATCH $query
            ${includeCold ? '' : 'AND p.status = $status'}
          ORDER BY p.last_accessed_at DESC, p.created_at DESC
          LIMIT $limit
        `)
        .all({
          $query: ftsQuery,
          ...(includeCold ? {} : { $status: 'warm' }),
          $limit: 200,
        });
      return rows.map(row => this.toMemoryRecord(row));
    } catch (error) {
      console.log(`[Memory] FTS query failed, using LIKE candidates only: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private searchContextMemoryCandidatesByLike(terms: string[], includeCold: boolean): MemoryRecord[] {
    const clauses = terms.map((_, index) => `(
      content LIKE $term${index} ESCAPE '\\'
      OR topic LIKE $term${index} ESCAPE '\\'
      OR user_state LIKE $term${index} ESCAPE '\\'
      OR behavior_signal LIKE $term${index} ESCAPE '\\'
      OR interaction_result LIKE $term${index} ESCAPE '\\'
    )`);
    const params: Record<string, SqlValue> = {
      $limit: 200,
    };
    terms.forEach((term, index) => {
      params[`$term${index}`] = `%${escapeLike(term)}%`;
    });
    const rows = this.sqlite
      .query<PrunedMemoryRow, Record<string, SqlValue>>(`
        SELECT *
        FROM pruned_memories
        WHERE (${clauses.join(' OR ')})
          ${includeCold ? '' : 'AND status = $status'}
        ORDER BY last_accessed_at DESC, created_at DESC
        LIMIT $limit
      `)
      .all({
        ...params,
        ...(includeCold ? {} : { $status: 'warm' }),
      });
    return rows.map(row => this.toMemoryRecord(row));
  }

  private getPendingMemoryCandidateMatchCount(terms: string[]): number {
    if (terms.length === 0) return 0;
    const clauses = terms.map((_, index) => 'draft_json LIKE $term' + index + ' ESCAPE \'\\\'');
    const params: Record<string, SqlValue> = {};
    terms.forEach((term, index) => {
      params[`$term${index}`] = `%${escapeLike(term)}%`;
    });
    const row = this.sqlite
      .query<{ count: number }, Record<string, SqlValue>>(`
        SELECT COUNT(*) AS count
        FROM memory_candidates
        WHERE status = 'pending'
          AND (${clauses.join(' OR ')})
      `)
      .get(params);
    return row?.count ?? 0;
  }

  private touchMemory(memoryId: string, accessedAt: number, incrementHit: boolean): void {
    this.sqlite
      .query(`
        UPDATE pruned_memories
        SET last_accessed_at = $lastAccessedAt,
            hit_count = hit_count + $hitIncrement
        WHERE memory_id = $memoryId
      `)
      .run({
        $memoryId: memoryId,
        $lastAccessedAt: accessedAt,
        $hitIncrement: incrementHit ? 1 : 0,
      });
  }

  private updateMemoryCandidateStatus(candidateId: string, status: MemoryCandidateStatus): MemoryCandidateRecord | null {
    const existing = this.getMemoryCandidate(candidateId);
    if (!existing) return null;
    this.sqlite
      .query(`
        UPDATE memory_candidates
        SET status = $status,
            reviewed_at = $reviewedAt
        WHERE candidate_id = $candidateId
      `)
      .run({
        $candidateId: candidateId,
        $status: status,
        $reviewedAt: Date.now(),
      });
    return this.getMemoryCandidate(candidateId);
  }

  private upsertPrunedMemoryFts(memory: MemoryRecord): void {
    if (!this.hasMemoryFts) return;
    try {
      this.deletePrunedMemoryFts(memory.id);
      this.sqlite
        .query(`
          INSERT INTO pruned_memories_fts (
            memory_id, content, topic, user_state, behavior_signal, interaction_result
          )
          VALUES (
            $memoryId, $content, $topic, $userState, $behaviorSignal, $interactionResult
          )
        `)
        .run({
          $memoryId: memory.id,
          $content: memory.content,
          $topic: memory.topic,
          $userState: memory.userState,
          $behaviorSignal: memory.behaviorSignal,
          $interactionResult: memory.interactionResult,
        });
    } catch (error) {
      console.log(`[Memory] FTS sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private deletePrunedMemoryFts(memoryId: string): void {
    if (!this.hasMemoryFts) return;
    try {
      this.sqlite.query('DELETE FROM pruned_memories_fts WHERE memory_id = ?').run(memoryId);
    } catch {
      // FTS is an optimization; stale rows fall back to LIKE on the next query.
    }
  }

  private toSessionRecord(row: ConversationSessionRow): ConversationSessionRecord {
    return {
      conversationId: row.conversation_id,
      messages: JSON.parse(row.messages) as ConversationMessage[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toMemoryRecord(row: PrunedMemoryRow): MemoryRecord {
    return {
      id: row.memory_id,
      sourceConversationId: row.source_conversation_id,
      content: row.content,
      baseScore: row.base_score,
      hitCount: row.hit_count,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      status: row.status,
      topic: row.topic,
      userState: row.user_state,
      behaviorSignal: row.behavior_signal,
      interactionResult: row.interaction_result,
      location: row.location,
      timeBucket: row.time_bucket,
      dayType: row.day_type,
    };
  }

  private toMemoryCandidateRecord(row: MemoryCandidateRow): MemoryCandidateRecord {
    return {
      id: row.candidate_id,
      sourceConversationId: row.source_conversation_id,
      draftJson: row.draft_json,
      score: row.score,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    };
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(limit!)));
}

function normalizeOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.trunc(offset!));
}

function normalizeBaseScore(score: number | undefined): number {
  if (!Number.isFinite(score)) return 3;
  return Math.max(1, Math.min(5, Math.round(score!)));
}

function getTimeBucket(date: Date): TimeBucket {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function getDayType(date: Date): DayType {
  const day = date.getDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

function tokenize(value: string): string[] {
  const baseTerms = value
    .toLowerCase()
    .split(/[\s,，。.!?！？;；:：、]+/)
    .map(term => term.trim())
    .filter(term => term.length > 1 && !TOKEN_STOP_WORDS.has(term));

  const cjkTerms = Array.from(value.matchAll(/[\p{Script=Han}]{2,}/gu))
    .flatMap(match => toBigrams(match[0]));

  return Array.from(new Set([...baseTerms, ...cjkTerms]));
}

function toBigrams(value: string): string[] {
  const chars = Array.from(value.toLowerCase());
  const bigrams: string[] = [];
  for (let index = 0; index < chars.length - 1; index++) {
    bigrams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return bigrams;
}

function scoreMemory(memory: MemoryRecord, terms: string[], options: ContextMemorySearchOptions): MemoryScore {
  const haystack = [
    memory.content,
    memory.topic,
    memory.userState,
    memory.behaviorSignal,
    memory.interactionResult,
  ].join(' ').toLowerCase();
  const semanticScore = terms.reduce(
    (score, term) => (haystack.includes(term) ? score + SEMANTIC_TERM_SCORE : score),
    0,
  );
  const situationScore = (
    (options.location && memory.location === options.location ? 2 : 0)
    + (options.timeBucket && memory.timeBucket === options.timeBucket ? 1 : 0)
    + (options.dayType && memory.dayType === options.dayType ? 1 : 0)
  );
  const heatScore = calculateHeat(memory, Date.now());
  return {
    semanticScore,
    situationScore,
    heatScore,
    totalScore: semanticScore + situationScore + heatScore,
  };
}

function calculateHeat(memory: MemoryRecord, now: number): number {
  const deltaDays = Math.max(0, (now - memory.lastAccessedAt) / MS_PER_DAY);
  const rawHeat = (memory.baseScore * (memory.hitCount + 1)) / ((deltaDays + 1) ** MEMORY_HEAT_DECAY_GAMMA);
  const statusAdjustedHeat = memory.status === 'cold' ? rawHeat * MEMORY_COLD_HEAT_MULTIPLIER : rawHeat;
  return Math.min(MEMORY_HEAT_SCORE_CAP, statusAdjustedHeat);
}

function toFtsQuery(terms: string[]): string {
  return terms
    .map(term => term.replace(/["*]/g, '').trim())
    .filter(Boolean)
    .map(term => `"${term}"`)
    .join(' OR ');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function traceContextMemorySearch(
  query: string,
  candidateCount: number,
  matches: Array<{ memory: MemoryRecord; score: MemoryScore }>,
  mode = 'semantic',
  reason?: 'no_terms' | 'below_semantic_threshold' | 'cold_filtered' | 'candidate_pending',
): void {
  const injected = matches.map(item => ({
    id: item.memory.id,
    topic: item.memory.topic,
    semanticScore: item.score.semanticScore,
    situationScore: item.score.situationScore,
    heatScore: Number(item.score.heatScore.toFixed(3)),
    totalScore: Number(item.score.totalScore.toFixed(3)),
  }));

  console.log(`[Memory] mode=${mode} Context search query="${query}" candidates=${candidateCount} injected=${matches.length}${reason ? ` reason=${reason}` : ''}`);
  if (injected.length > 0) {
    console.log(`[Memory] Injected memories: ${JSON.stringify(injected)}`);
    return;
  }
  console.log('[Memory] No relevant long-term memory injected.');
}

function traceRecentMemorySearch(
  query: string,
  candidateCount: number,
  matches: MemoryRecord[],
): void {
  const injected = matches.map(item => ({
    id: item.id,
    topic: item.topic,
    createdAt: item.createdAt,
    lastAccessedAt: item.lastAccessedAt,
  }));

  console.log(`[Memory] mode=recent_recall Context search query="${query}" candidates=${candidateCount} injected=${matches.length}`);
  if (injected.length > 0) {
    console.log(`[Memory] Injected recent memories: ${JSON.stringify(injected)}`);
    return;
  }
  console.log('[Memory] No recent long-term memory found.');
}

export const memory = new MemoryDatabase();
