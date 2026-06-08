import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { migrateRuntimeData } from '@/server/scripts/migrate_runtime_data';

const tempDirs: string[] = [];

function createTempDbDir(): string {
    const dir = join(process.cwd(), 'src', 'server', 'db', `migration-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('runtime data migration script', () => {
    test('migrates legacy face json into an empty sqlite table', async () => {
        const dbDir = createTempDbDir();
        writeFileSync(join(dbDir, 'face_db.json'), JSON.stringify([
            { name: 'master', descriptor: [0.1, 0.2, 0.3] },
        ]), 'utf8');

        const result = migrateRuntimeData('face', dbDir);
        expect(result.target).toBe('face');
        expect(result.imported).toBe(1);

        const sqlite = new Database(join(dbDir, 'face_db.sqlite'));
        const row = sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM face_records').get();
        expect(row?.count).toBe(1);
        sqlite.close();
    });

    test('fails when legacy face json is missing', async () => {
        expect(() => migrateRuntimeData('face', createTempDbDir())).toThrow('Legacy face JSON not found');
    });

    test('migrates legacy memory exchange rows into the new conversations table', async () => {
        const dbDir = createTempDbDir();
        const sqlite = new Database(join(dbDir, 'memory.sqlite'));
        sqlite.run(`
            CREATE TABLE conversations (
                conversation_id TEXT PRIMARY KEY,
                user_content TEXT NOT NULL,
                agent_content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        sqlite
            .query(`
                INSERT INTO conversations (conversation_id, user_content, agent_content, created_at, updated_at)
                VALUES ($conversationId, $userContent, $agentContent, $createdAt, $updatedAt)
            `)
            .run({
                $conversationId: 'legacy-session',
                $userContent: 'hello',
                $agentContent: 'hi',
                $createdAt: '2026-06-07T01:00:00.000Z',
                $updatedAt: '2026-06-07T01:01:00.000Z',
            });
        sqlite.close();

        const result = migrateRuntimeData('memory', dbDir);
        expect(result.target).toBe('memory');
        expect(result.imported).toBe(1);

        const verify = new Database(join(dbDir, 'memory.sqlite'));
        const row = verify
            .query<{ messages: string }, []>('SELECT messages FROM conversations WHERE conversation_id = "legacy-session"')
            .get();
        expect(JSON.parse(row?.messages ?? '[]').map((item: { content: string }) => item.content)).toEqual(['hello', 'hi']);
        expect(verify.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM conversations_exchange_legacy').get()?.count).toBe(1);
        verify.close();
    });
});
