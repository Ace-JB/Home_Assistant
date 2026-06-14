import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { MemoryDatabase } from '@modules/memory';

const tempDbPaths: string[] = [];

function createTempPath(): string {
  const path = join(process.cwd(), 'src', 'server', 'db', `memory-test-${Date.now()}-${Math.random()}.sqlite`);
  tempDbPaths.push(path, `${path}-shm`, `${path}-wal`);
  return path;
}

function createTempMemory(): MemoryDatabase {
  return new MemoryDatabase(createTempPath());
}

afterEach(() => {
  for (const path of tempDbPaths.splice(0)) {
    rmSync(path, { force: true });
  }
});

describe('MemoryDatabase', () => {
  test('should create and get a conversation session by conversation_id', () => {
    const db = createTempMemory();

    const session = db.createConversationSession({
      conversation_id: 'session-1',
      created_at: '2026-05-15T01:00:00.000Z',
    });

    expect(session.conversationId).toBe('session-1');
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBe('2026-05-15T01:00:00.000Z');
    expect(db.getConversationSession('session-1')?.conversationId).toBe('session-1');
    expect(db.getConversationSession('missing')).toBeNull();

    db.close();
  });

  test('should append multiple user-agent turns to one session', () => {
    const db = createTempMemory();

    db.createConversationSession({
      conversation_id: 'loop-1',
      created_at: '2026-05-15T01:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'loop-1',
      user_content: 'turn on the kitchen light',
      agent_content: 'Done.',
      created_at: '2026-05-15T01:01:00.000Z',
    });
    const updated = db.appendConversationTurn({
      conversation_id: 'loop-1',
      user_content: 'also dim it to 40 percent',
      agent_content: 'Dimmed to 40 percent.',
      created_at: '2026-05-15T01:02:00.000Z',
    });

    expect(updated.messages.map(message => message.role)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(updated.messages.map(message => message.content)).toEqual([
      'turn on the kitchen light',
      'Done.',
      'also dim it to 40 percent',
      'Dimmed to 40 percent.',
    ]);

    db.close();
  });

  test('should hide empty conversation sessions from search and count', () => {
    const db = createTempMemory();

    db.createConversationSession({ conversation_id: 'empty-session' });
    db.appendConversationTurn({
      conversation_id: 'real-session',
      user_content: 'how do I cook tomato eggs',
      agent_content: 'Use tomatoes and eggs.',
      created_at: '2026-05-15T01:00:00.000Z',
    });

    expect(db.searchConversationSessions().map(item => item.conversationId)).toEqual(['real-session']);
    expect(db.countConversationSessions()).toBe(1);

    db.close();
  });

  test('should remove empty conversation sessions on initialization', () => {
    const path = createTempPath();
    const sqlite = new Database(path);
    sqlite.run(`
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite
      .query('INSERT INTO conversations (conversation_id, messages, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('empty-session', '[]', '2026-05-15T01:00:00.000Z', '2026-05-15T01:00:00.000Z');
    sqlite.close();

    const db = new MemoryDatabase(path);

    expect(db.getConversationSession('empty-session')).toBeNull();

    db.close();
  });

  test('should return recent conversation messages for follow-up context', () => {
    const db = createTempMemory();

    db.appendConversationTurn({
      conversation_id: 'cooking-session',
      user_content: '请告诉我番茄炒蛋怎么做',
      agent_content: '番茄炒蛋需要先炒鸡蛋，再炒番茄，最后合炒调味。',
      created_at: '2026-05-15T01:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'cooking-session',
      user_content: '有什么需要注意的吗',
      agent_content: '注意火候和调味。',
      created_at: '2026-05-15T01:01:00.000Z',
    });

    const recent = db.getRecentConversationMessages({ conversationId: 'cooking-session', limit: 2 });

    expect(recent.map(item => item.content)).toEqual(['有什么需要注意的吗', '注意火候和调味。']);

    db.close();
  });

  test('should fuzzy search session messages', () => {
    const db = createTempMemory();

    db.appendConversationTurn({
      conversation_id: 'session-1',
      user_content: 'please open the bedroom curtains',
      agent_content: 'Opening bedroom curtains.',
      created_at: '2026-05-15T01:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'session-2',
      user_content: 'what is the weather',
      agent_content: 'The forecast is rainy.',
      created_at: '2026-05-15T02:00:00.000Z',
    });

    expect(db.searchConversationSessions({ query: 'bedroom' }).map(item => item.conversationId)).toEqual(['session-1']);
    expect(db.searchConversationSessions({ query: 'rainy' }).map(item => item.conversationId)).toEqual(['session-2']);

    db.close();
  });

  test('should search sessions by time period', () => {
    const db = createTempMemory();

    db.appendConversationTurn({
      conversation_id: 'morning',
      user_content: 'morning command',
      agent_content: 'morning response',
      created_at: '2026-05-15T00:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'noon',
      user_content: 'noon command',
      agent_content: 'noon response',
      created_at: '2026-05-15T04:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'night',
      user_content: 'night command',
      agent_content: 'night response',
      created_at: '2026-05-15T12:00:00.000Z',
    });

    const results = db.searchConversationSessions({
      from: '2026-05-15T03:00:00.000Z',
      to: '2026-05-15T13:00:00.000Z',
    });

    expect(results.map(item => item.conversationId)).toEqual(['night', 'noon']);

    db.close();
  });

  test('should paginate newest-first sessions', () => {
    const db = createTempMemory();

    for (let index = 1; index <= 4; index++) {
      db.appendConversationTurn({
        conversation_id: `session-${index}`,
        user_content: `command ${index}`,
        agent_content: `response ${index}`,
        created_at: `2026-05-15T0${index}:00:00.000Z`,
      });
    }

    expect(db.searchConversationSessions({ limit: 2 }).map(item => item.conversationId)).toEqual(['session-4', 'session-3']);
    expect(db.searchConversationSessions({ limit: 2, offset: 2 }).map(item => item.conversationId)).toEqual(['session-2', 'session-1']);

    db.close();
  });

  test('should count sessions with and without filters', () => {
    const db = createTempMemory();

    db.appendConversationTurn({
      conversation_id: 'session-1',
      user_content: 'turn on the lamp',
      agent_content: 'Lamp is on.',
      created_at: '2026-05-15T01:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'session-2',
      user_content: 'turn off the lamp',
      agent_content: 'Lamp is off.',
      created_at: '2026-05-15T02:00:00.000Z',
    });
    db.appendConversationTurn({
      conversation_id: 'session-3',
      user_content: 'play music',
      agent_content: 'Playing music.',
      created_at: '2026-05-15T03:00:00.000Z',
    });

    expect(db.countConversationSessions()).toBe(3);
    expect(db.countConversationSessions({ query: 'lamp' })).toBe(2);
    expect(db.countConversationSessions({ from: '2026-05-15T02:30:00.000Z' })).toBe(1);
    expect(db.countConversationSessions({ conversationId: 'session-2' })).toBe(1);

    db.close();
  });

  test('should remove a single conversation session', () => {
    const db = createTempMemory();

    db.appendConversationTurn({
      conversation_id: 'remove-me',
      user_content: 'remove this',
      agent_content: 'ok',
    });
    db.appendConversationTurn({
      conversation_id: 'keep-me',
      user_content: 'keep this',
      agent_content: 'ok',
    });

    expect(db.removeConversationSession('remove-me')).toBe(true);
    expect(db.removeConversationSession('missing')).toBe(false);
    expect(db.getConversationSession('remove-me')).toBeNull();
    expect(db.countConversationSessions()).toBe(1);

    db.close();
  });

  test('should save pruned memories in a separate table and search them for context', () => {
    const db = createTempMemory();

    db.createConversationSession({ conversation_id: 'source-1' });
    db.savePrunedMemory({
      source_conversation_id: 'source-1',
      content: 'The user prefers warm living room lights in the evening.',
      topic: 'lighting',
      user_state: 'relaxed',
      behavior_signal: 'prefers warm living room lights',
      interaction_result: 'assistant should keep lighting warm',
      base_score: 5,
      created_at: new Date('2026-05-15T01:00:00.000Z').getTime(),
    });
    db.savePrunedMemory({
      source_conversation_id: 'source-2',
      content: 'The kitchen light should stay bright during cooking.',
      topic: 'kitchen lighting',
      behavior_signal: 'bright light during cooking',
      base_score: 4,
      created_at: new Date('2026-05-15T02:00:00.000Z').getTime(),
    });

    expect(db.searchPrunedMemories({ sourceConversationId: 'source-1' })).toHaveLength(1);
    expect(db.searchPrunedMemories({ query: 'kitchen' })[0]?.content).toContain('kitchen');
    expect(db.getContextMemories('warm lights', 5)[0]?.content).toContain('warm living room lights');

    db.close();
  });

  test('should update and remove pruned memories', () => {
    const db = createTempMemory();

    const saved = db.savePrunedMemory({
      source_conversation_id: 'source-1',
      content: 'Initial memory.',
      created_at: new Date('2026-05-15T01:00:00.000Z').getTime(),
    });

    const updated = db.updatePrunedMemory({
      memory_id: saved.id,
      content: 'Updated memory.',
      topic: 'updated topic',
      base_score: 5,
    });

    expect(updated?.content).toBe('Updated memory.');
    expect(updated?.topic).toBe('updated topic');
    expect(updated?.baseScore).toBe(5);
    expect(db.updatePrunedMemory({ memory_id: 'missing', content: 'Nope' })).toBeNull();
    expect(db.removePrunedMemory(saved.id)).toBe(true);
    expect(db.removePrunedMemory(saved.id)).toBe(false);
    expect(db.getPrunedMemory(saved.id)).toBeNull();

    db.close();
  });

  test('should update instead of duplicating pruned memories for the same source session', () => {
    const db = createTempMemory();

    const first = db.savePrunedMemory({
      source_conversation_id: 'source-1',
      content: 'First approved memory.',
      base_score: 2,
    });
    const second = db.savePrunedMemory({
      source_conversation_id: 'source-1',
      content: 'Second approved memory.',
      base_score: 5,
      topic: 'updated',
    });

    expect(second.id).toBe(first.id);
    expect(db.searchPrunedMemories({ sourceConversationId: 'source-1' })).toHaveLength(1);
    expect(db.getPrunedMemory(first.id)?.content).toBe('Second approved memory.');
    expect(db.getPrunedMemory(first.id)?.baseScore).toBe(5);
    expect(first.status).toBe('warm');
    expect(second.status).toBe('warm');

    db.close();
  });

  test('should create new pruned memories as warm even with a low base score', () => {
    const db = createTempMemory();

    const saved = db.savePrunedMemory({
      source_conversation_id: 'source-1',
      content: 'Low score but newly approved memory.',
      base_score: 1,
    });

    expect(saved.status).toBe('warm');
    expect(saved.impressions).toBe(0);
    expect(saved.positiveFeedbackCount).toBe(0);
    expect(saved.negativeFeedbackCount).toBe(0);
    expect(saved.ignoredFeedbackCount).toBe(0);

    db.close();
  });

  test('should rank context memories by content and situation and update hit count', () => {
    const db = createTempMemory();

    const createdAt = new Date('2026-05-16T11:00:00.000Z').getTime();
    const relevant = db.savePrunedMemory({
      source_conversation_id: 'source-1',
      content: 'The user likes bright kitchen lighting while cooking lunch.',
      topic: 'kitchen lighting',
      behavior_signal: 'cooks with bright kitchen lights',
      base_score: 4,
      location: 'kitchen',
      created_at: createdAt,
    });
    db.savePrunedMemory({
      source_conversation_id: 'source-2',
      content: 'The user prefers soft bedroom light before sleep.',
      topic: 'bedroom lighting',
      base_score: 4,
      location: 'bedroom',
      created_at: new Date('2026-05-16T23:00:00.000Z').getTime(),
    });

    const results = db.getContextMemories({
      query: 'kitchen cooking light',
      location: 'kitchen',
      timeBucket: 'noon',
      dayType: 'weekend',
      limit: 1,
    });

    expect(results[0]?.id).toBe(relevant.id);
    expect(db.getPrunedMemory(relevant.id)?.hitCount).toBe(1);
    expect(db.getPrunedMemory(relevant.id)?.impressions).toBe(1);

    db.close();
  });

  test('should rank context memories with heat score decay over time', () => {
    const db = createTempMemory();

    const oldHighScore = db.savePrunedMemory({
      source_conversation_id: 'old-high-score',
      content: 'The user wants focus mode while working.',
      topic: 'focus mode',
      base_score: 5,
      created_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    db.savePrunedMemory({
      source_conversation_id: 'fresh-low-score',
      content: 'The user wants focus mode while working.',
      topic: 'focus mode',
      base_score: 2,
      created_at: Date.now(),
    });

    const results = db.getContextMemories({
      query: 'focus mode working',
      limit: 1,
    });

    expect(results[0]?.id).not.toBe(oldHighScore.id);

    db.close();
  });

  test('should not inject hot memories without semantic relevance', () => {
    const db = createTempMemory();

    const unrelated = db.savePrunedMemory({
      source_conversation_id: 'hot-unrelated',
      content: 'The user prefers warm bedroom light before sleep.',
      topic: 'bedroom lighting',
      base_score: 5,
      created_at: Date.now(),
    });
    db.getContextMemories({
      query: 'bedroom lighting sleep',
      limit: 1,
    });

    const results = db.getContextMemories({
      query: 'weather forecast today',
      limit: 5,
    });

    expect(results).toEqual([]);
    expect(db.getPrunedMemory(unrelated.id)?.hitCount).toBe(1);

    db.close();
  });

  test('should not inject memories from situation match alone', () => {
    const db = createTempMemory();

    const situationOnly = db.savePrunedMemory({
      source_conversation_id: 'situation-only',
      content: 'The user prefers quiet reading music in the living room.',
      topic: 'reading music',
      base_score: 4,
      location: 'kitchen',
      created_at: new Date('2026-05-16T11:00:00.000Z').getTime(),
    });

    const results = db.getContextMemories({
      query: 'turn on the oven',
      location: 'kitchen',
      timeBucket: 'noon',
      dayType: 'weekend',
      limit: 5,
    });

    expect(results).toEqual([]);
    expect(db.getPrunedMemory(situationOnly.id)?.hitCount).toBe(0);

    db.close();
  });

  test('should use situation and heat only to rank semantically relevant memories', () => {
    const db = createTempMemory();

    const livingRoom = db.savePrunedMemory({
      source_conversation_id: 'living-room',
      content: 'The user likes warm light while relaxing in the living room.',
      topic: 'living room lighting',
      base_score: 2,
      location: 'living_room',
      created_at: new Date('2026-05-16T20:00:00.000Z').getTime(),
    });
    const kitchen = db.savePrunedMemory({
      source_conversation_id: 'kitchen',
      content: 'The user likes bright light while cooking in the kitchen.',
      topic: 'kitchen lighting',
      base_score: 2,
      location: 'kitchen',
      created_at: new Date('2026-05-16T11:00:00.000Z').getTime(),
    });

    const results = db.getContextMemories({
      query: 'light',
      location: 'kitchen',
      timeBucket: 'noon',
      dayType: 'weekend',
      limit: 2,
    });

    expect(results.map(item => item.id)).toEqual([kitchen.id, livingRoom.id]);

    db.close();
  });

  test('should return recent long-term memories for recent recall mode', () => {
    const db = createTempMemory();

    db.savePrunedMemory({
      source_conversation_id: 'math',
      content: 'The user asked simple math questions.',
      topic: 'math',
      base_score: 2,
      created_at: new Date('2026-05-15T10:00:00.000Z').getTime(),
    });
    const cooking = db.savePrunedMemory({
      source_conversation_id: 'cooking',
      content: '用户询问了辣椒炒肉和番茄炒蛋的制作方法。',
      topic: '家常菜的做法',
      base_score: 3,
      created_at: new Date('2026-05-21T10:00:00.000Z').getTime(),
    });

    const results = db.getContextMemories({
      query: '我们最近有聊过什么吗',
      mode: 'recent_recall',
      limit: 1,
    });

    expect(results.map(item => item.id)).toEqual([cooking.id]);
    expect(db.getPrunedMemory(cooking.id)?.hitCount).toBe(1);

    db.close();
  });

  test('should supplement semantic results with recent memories in hybrid mode', () => {
    const db = createTempMemory();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      const olderRelevant = db.savePrunedMemory({
        source_conversation_id: 'older-relevant',
        content: 'The user likes warm light while cooking.',
        topic: 'kitchen lighting',
        base_score: 3,
        created_at: new Date('2026-05-15T10:00:00.000Z').getTime(),
      });
      const recentUnrelated = db.savePrunedMemory({
        source_conversation_id: 'recent-unrelated',
        content: '用户询问了辣椒炒肉和番茄炒蛋的制作方法。',
        topic: '家常菜的做法',
        base_score: 3,
        created_at: new Date('2026-05-21T10:00:00.000Z').getTime(),
      });

      const results = db.getContextMemories({
        query: 'light',
        mode: 'hybrid',
        limit: 2,
      });

      expect(results.map(item => item.id)).toEqual([olderRelevant.id, recentUnrelated.id]);
      const injectedLog = logs.find(line => line.includes('[Memory] Injected memories:'));
      expect(injectedLog).toContain('"retrievalReason":"recent_fallback"');
      expect(injectedLog).toContain('"relevanceScore":0');
      expect(injectedLog).toContain('"gateRelevanceScore":1');
    } finally {
      console.log = originalLog;
      db.close();
    }
  });

  test('should create, approve, and reject memory candidates', () => {
    const db = createTempMemory();
    const draft = JSON.stringify({
      content: 'The user prefers concise answers.',
      topic: 'assistant style',
      user_state: 'focused',
      behavior_signal: 'prefers concise answers',
      interaction_result: 'assistant should keep answers short',
      retention_evaluation: { recommendation_score: 5, reason: 'explicit preference' },
    });

    const candidate = db.saveMemoryCandidate({
      source_conversation_id: 'candidate-source',
      draft_json: draft,
      score: 5,
    });
    const duplicate = db.saveMemoryCandidate({
      source_conversation_id: 'candidate-source',
      draft_json: draft,
      score: 4,
    });

    expect(duplicate.id).toBe(candidate.id);
    expect(db.searchMemoryCandidates({ status: 'pending' })).toHaveLength(1);
    expect(db.getContextMemories({ query: 'concise answers', limit: 5 })).toEqual([]);

    const approved = db.approveMemoryCandidate(candidate.id, {
      content: 'The user prefers concise answers.',
      topic: 'assistant style',
      base_score: 5,
    });

    expect(approved?.content).toContain('concise answers');
    expect(db.getMemoryCandidate(candidate.id)?.status).toBe('approved');
    expect(db.getContextMemories({ query: 'concise answers', limit: 1 })[0]?.id).toBe(approved?.id);

    const rejected = db.saveMemoryCandidate({
      source_conversation_id: 'rejected-source',
      draft_json: 'The user dislikes long answers.',
      score: 3,
    });

    expect(db.rejectMemoryCandidate(rejected.id)?.status).toBe('rejected');
    expect(db.searchMemoryCandidates({ status: 'pending' }).map(item => item.id)).toEqual([]);

    db.close();
  });

  test('should score ambient freshness from creation time instead of ordinary access time', () => {
    const db = createTempMemory();
    const oldPreference = db.savePrunedMemory({
      source_conversation_id: 'old-ambient-style',
      content: 'The user prefers brief direct style when discussing lights.',
      topic: 'assistant style',
      base_score: 5,
      created_at: Date.now() - 90 * 24 * 60 * 60 * 1000,
    });
    const newerPreference = db.savePrunedMemory({
      source_conversation_id: 'newer-ambient-style',
      content: 'The user prefers brief direct style when discussing music.',
      topic: 'assistant style',
      base_score: 5,
      created_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
    });

    expect(db.getContextMemories({ query: 'lights', limit: 1 })[0]?.id).toBe(oldPreference.id);
    expect(db.getPrunedMemory(oldPreference.id)!.lastAccessedAt).toBeGreaterThan(oldPreference.lastAccessedAt);
    expect(db.getAmbientMemories({ limit: 1 })[0]?.id).toBe(newerPreference.id);

    db.close();
  });

  test('should score cold memories instead of filtering them from semantic retrieval', () => {
    const db = createTempMemory();
    const cold = db.savePrunedMemory({
      source_conversation_id: 'cold-source',
      content: 'The user likes green tea after dinner.',
      topic: 'tea preference',
      base_score: 2,
      status: 'cold',
      created_at: Date.now(),
    });

    expect(db.getContextMemories({ query: 'green tea dinner', limit: 5 })[0]?.id).toBe(cold.id);
    expect(db.getContextMemories({ query: 'recent memories', mode: 'recent_recall', limit: 1 })[0]?.id).toBe(cold.id);

    db.close();
  });

  test('should retrieve ambient memories without query relevance gating', () => {
    const db = createTempMemory();
    const createdAt = Date.now() - 20 * 24 * 60 * 60 * 1000;
    const style = db.savePrunedMemory({
      source_conversation_id: 'ambient-style',
      content: 'The user prefers concise answers and likes to be called 主人.',
      topic: 'assistant style',
      user_state: 'prefers concise answers',
      behavior_signal: 'global preference',
      base_score: 5,
      created_at: createdAt,
    });

    expect(db.getAmbientMemories({ limit: 1 })[0]?.id).toBe(style.id);
    const afterAmbient = db.getPrunedMemory(style.id);
    expect(afterAmbient?.impressions).toBe(1);
    expect(afterAmbient?.hitCount).toBe(0);
    expect(afterAmbient?.lastAccessedAt).toBe(style.lastAccessedAt);

    db.close();
  });

  test('should record explicit positive negative and ignored memory feedback', () => {
    const db = createTempMemory();
    const saved = db.savePrunedMemory({
      source_conversation_id: 'feedback-source',
      content: 'The user prefers direct answers.',
      topic: 'assistant style',
      base_score: 4,
    });

    expect(db.recordMemoryFeedback({ memory_id: saved.id, feedback: 'positive' })?.positiveFeedbackCount).toBe(1);
    expect(db.recordMemoryFeedback({ memory_id: saved.id, feedback: 'negative' })?.negativeFeedbackCount).toBe(1);
    expect(db.recordMemoryFeedback({ memory_id: saved.id, feedback: 'ignored' })?.ignoredFeedbackCount).toBe(1);
    expect(db.recordMemoryFeedback({ memory_id: 'missing', feedback: 'positive' })).toBeNull();

    db.close();
  });

  test('should cool low-value stale memories during lifecycle maintenance', () => {
    const db = createTempMemory();
    const now = new Date('2026-06-20T10:00:00.000Z').getTime();
    const stale = db.savePrunedMemory({
      source_conversation_id: 'stale-low',
      content: 'The user once asked about a low value topic.',
      topic: 'low value',
      base_score: 2,
      created_at: now - 45 * 24 * 60 * 60 * 1000,
    });
    const important = db.savePrunedMemory({
      source_conversation_id: 'important',
      content: 'The user has a strong preference for concise answers.',
      topic: 'assistant style',
      base_score: 5,
      created_at: now - 45 * 24 * 60 * 60 * 1000,
    });

    expect(db.maintainMemoryLifecycle(now)).toBe(1);
    expect(db.getPrunedMemory(stale.id)?.status).toBe('cold');
    expect(db.getPrunedMemory(important.id)?.status).toBe('warm');
    expect(db.getContextMemories({ query: 'low value topic', limit: 1 })[0]?.id).toBe(stale.id);

    db.close();
  });

  test('should reject old exchange table at runtime instead of auto migrating it', () => {
    const path = createTempPath();
    const sqlite = new Database(path);
    sqlite.run(`
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        user_content TEXT NOT NULL,
        agent_content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite.close();

    expect(() => new MemoryDatabase(path)).toThrow();

    const verify = new Database(path);
    const archived = verify
      .query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'conversations_exchange_%'
      `)
      .get();
    expect(archived?.count ?? 0).toBe(0);
    verify.close();
  });
});
