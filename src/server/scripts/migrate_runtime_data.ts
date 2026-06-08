import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getDataDbDir } from '@/server/services/runtime-paths';

type MigrationTarget = 'memory' | 'face';

type LegacyFaceRecord = {
  name?: unknown;
  descriptor?: unknown;
};

type LegacyConversationRow = {
  conversation_id: string;
  user_content: string;
  agent_content: string;
  created_at: string;
  updated_at: string;
};

export type RuntimeMigrationResult = {
  target: MigrationTarget;
  imported: number;
  sourcePath?: string;
  sourceTable?: string;
  targetPath: string;
  targetTable?: string;
};

function usage(): never {
  console.error('Usage: bun src/server/scripts/migrate_runtime_data.ts memory|face');
  process.exit(2);
}

function parseTarget(value: string | undefined): MigrationTarget {
  if (value === 'memory' || value === 'face') return value;
  usage();
}

function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA foreign_keys = ON');
  return sqlite;
}

function tableExists(sqlite: Database, name: string): boolean {
  const row = sqlite
    .query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `)
    .get(name);
  return (row?.count ?? 0) > 0;
}

function tableSql(sqlite: Database, name: string): string {
  const row = sqlite
    .query<{ sql: string | null }, [string]>(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `)
    .get(name);
  return row?.sql ?? '';
}

function countRows(sqlite: Database, table: string): number {
  if (!tableExists(sqlite, table)) return 0;
  const row = sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

function ensureFaceSchema(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS face_records (
      name TEXT PRIMARY KEY,
      descriptor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function ensureMemorySchema(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      messages TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations (created_at)');
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations (updated_at)');
  sqlite.run('CREATE INDEX IF NOT EXISTS idx_conversations_messages ON conversations (messages)');
}

export function migrateRuntimeData(target: MigrationTarget, dbDir = getDataDbDir()): RuntimeMigrationResult {
  return target === 'face' ? migrateFace(dbDir) : migrateMemory(dbDir);
}

function migrateFace(dbDir: string): RuntimeMigrationResult {
  const faceJsonPath = join(dbDir, 'face_db.json');
  const faceDbPath = join(dbDir, 'face_db.sqlite');
  const sourcePath = resolve(faceJsonPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Legacy face JSON not found at ${sourcePath}`);
  }

  const sqlite = openDb(faceDbPath);
  try {
    ensureFaceSchema(sqlite);
    const existing = countRows(sqlite, 'face_records');
    if (existing > 0) {
      throw new Error(`Target face table is not empty (${existing} records). Refusing to merge legacy data.`);
    }

    const raw = JSON.parse(readFileSync(sourcePath, 'utf8')) as LegacyFaceRecord[];
    if (!Array.isArray(raw)) {
      throw new Error('Legacy face JSON must be an array.');
    }

    const now = new Date().toISOString();
    const insert = sqlite.query(`
      INSERT INTO face_records (name, descriptor, created_at, updated_at)
      VALUES ($name, $descriptor, $createdAt, $updatedAt)
    `);
    let imported = 0;
    for (const record of raw) {
      if (typeof record.name !== 'string' || !record.name.trim() || !Array.isArray(record.descriptor)) {
        continue;
      }
      insert.run({
        $name: record.name.trim(),
        $descriptor: JSON.stringify(record.descriptor),
        $createdAt: now,
        $updatedAt: now,
      });
      imported += 1;
    }
    return { target: 'face', sourcePath, targetPath: resolve(faceDbPath), imported };
  } finally {
    sqlite.close();
  }
}

function migrateMemory(dbDir: string): RuntimeMigrationResult {
  const memoryDbPath = join(dbDir, 'memory.sqlite');
  const sqlite = openDb(memoryDbPath);
  try {
    if (!tableExists(sqlite, 'conversations')) {
      throw new Error(`Legacy conversations table not found at ${resolve(memoryDbPath)}`);
    }

    const sql = tableSql(sqlite, 'conversations');
    if (!sql.includes('user_content') || !sql.includes('agent_content')) {
      throw new Error('Current conversations table is already in the new schema; nothing to migrate.');
    }

    const existingTarget = tableExists(sqlite, 'conversation_sessions')
      ? countRows(sqlite, 'conversation_sessions')
      : 0;
    if (existingTarget > 0) {
      throw new Error(`Target conversation_sessions table is not empty (${existingTarget} records). Refusing to merge legacy data.`);
    }

    const rows = sqlite
      .query<LegacyConversationRow, []>(`
        SELECT conversation_id, user_content, agent_content, created_at, updated_at
        FROM conversations
        ORDER BY updated_at ASC, conversation_id ASC
      `)
      .all();

    sqlite.run('ALTER TABLE conversations RENAME TO conversations_exchange_legacy');
    ensureMemorySchema(sqlite);

    const insert = sqlite.query(`
      INSERT INTO conversations (conversation_id, messages, created_at, updated_at)
      VALUES ($conversationId, $messages, $createdAt, $updatedAt)
    `);
    for (const row of rows) {
      const messages = [
        { role: 'user', content: row.user_content, createdAt: row.created_at },
        { role: 'agent', content: row.agent_content, createdAt: row.updated_at },
      ];
      insert.run({
        $conversationId: row.conversation_id,
        $messages: JSON.stringify(messages),
        $createdAt: row.created_at,
        $updatedAt: row.updated_at,
      });
    }

    return {
      target: 'memory',
      sourceTable: 'conversations_exchange_legacy',
      targetTable: 'conversations',
      imported: rows.length,
      targetPath: resolve(memoryDbPath),
    };
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  try {
    const result = migrateRuntimeData(parseTarget(Bun.argv[2]));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
