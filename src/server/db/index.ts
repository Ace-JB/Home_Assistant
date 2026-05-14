import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export interface UserRecord {
  name: string;
  descriptor: number[];
  createdAt: string;
  updatedAt: string;
}

type FaceRecordRow = {
  name: string;
  descriptor: string;
  created_at: string;
  updated_at: string;
};

const DB_DIR = join(process.cwd(), 'src', 'server', 'db');
const SQLITE_DB_PATH = join(DB_DIR, 'face_db.sqlite');
const LEGACY_JSON_DB_PATH = join(DB_DIR, 'face_db.json');

export class FaceDatabase {
  private readonly sqlite: Database;

  constructor(dbPath = SQLITE_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.run('PRAGMA journal_mode = WAL');
    this.sqlite.run('PRAGMA foreign_keys = ON');
    this.init();
    if (dbPath === SQLITE_DB_PATH) {
      this.migrateLegacyJson();
    }
    console.log(`📖 已加载 ${this.count()} 个已知成员`);
  }

  save(name: string, descriptor: Float32Array | number[]): UserRecord {
    return this.upsert(name, descriptor);
  }

  update(name: string, descriptor: Float32Array | number[]): UserRecord | null {
    const existing = this.get(name);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.sqlite
      .query('UPDATE face_records SET descriptor = $descriptor, updated_at = $updatedAt WHERE name = $name')
      .run({
        $name: name,
        $descriptor: this.serializeDescriptor(descriptor),
        $updatedAt: now,
      });

    return this.get(name);
  }

  get(name: string): UserRecord | null {
    const row = this.sqlite
      .query<FaceRecordRow, [string]>('SELECT name, descriptor, created_at, updated_at FROM face_records WHERE name = ?')
      .get(name);

    return row ? this.toRecord(row) : null;
  }

  getRecords(): UserRecord[] {
    return this.list();
  }

  list(): UserRecord[] {
    return this.sqlite
      .query<FaceRecordRow, []>('SELECT name, descriptor, created_at, updated_at FROM face_records ORDER BY name')
      .all()
      .map(row => this.toRecord(row));
  }

  remove(name: string): boolean {
    const result = this.sqlite.query('DELETE FROM face_records WHERE name = ?').run(name);
    return result.changes > 0;
  }

  clear(): void {
    this.sqlite.run('DELETE FROM face_records');
  }

  count(): number {
    const row = this.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM face_records').get();
    return row?.count ?? 0;
  }

  close(): void {
    this.sqlite.close();
  }

  private init(): void {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS face_records (
        name TEXT PRIMARY KEY,
        descriptor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  private upsert(name: string, descriptor: Float32Array | number[]): UserRecord {
    const existing = this.get(name);
    const now = new Date().toISOString();

    this.sqlite
      .query(`
        INSERT INTO face_records (name, descriptor, created_at, updated_at)
        VALUES ($name, $descriptor, $createdAt, $updatedAt)
        ON CONFLICT(name) DO UPDATE SET
          descriptor = excluded.descriptor,
          updated_at = excluded.updated_at
      `)
      .run({
        $name: name,
        $descriptor: this.serializeDescriptor(descriptor),
        $createdAt: existing?.createdAt ?? now,
        $updatedAt: now,
      });

    console.log(existing ? `💾 已更新 ${name} 的存量特征` : `💾 已将新成员 ${name} 录入`);
    return this.get(name)!;
  }

  private migrateLegacyJson(): void {
    if (this.count() > 0 || !existsSync(LEGACY_JSON_DB_PATH)) return;

    const legacyRecords = JSON.parse(readFileSync(LEGACY_JSON_DB_PATH, 'utf-8')) as Array<{
      name: string;
      descriptor: number[];
    }>;

    for (const record of legacyRecords) {
      if (record.name && Array.isArray(record.descriptor)) {
        this.upsert(record.name, record.descriptor);
      }
    }
  }

  private serializeDescriptor(descriptor: Float32Array | number[]): string {
    return JSON.stringify(Array.from(descriptor));
  }

  private toRecord(row: FaceRecordRow): UserRecord {
    return {
      name: row.name,
      descriptor: JSON.parse(row.descriptor) as number[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const db = new FaceDatabase();
