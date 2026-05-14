import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { FaceDatabase } from '@db/index';

const tempDbPaths: string[] = [];

function createTempDb(): { db: FaceDatabase; path: string } {
  const path = join(process.cwd(), 'src', 'server', 'db', `test-${Date.now()}-${Math.random()}.sqlite`);
  tempDbPaths.push(path, `${path}-shm`, `${path}-wal`);
  return { db: new FaceDatabase(path), path };
}

afterEach(() => {
  for (const path of tempDbPaths.splice(0)) {
    rmSync(path, { force: true });
  }
});

describe('FaceDatabase', () => {
  test('should save, update, get, list, and remove face records', () => {
    const { db } = createTempDb();

    const saved = db.save('master', new Float32Array([0.1, 0.2, 0.3]));
    expect(saved.name).toBe('master');
    expect(saved.descriptor[0]).toBeCloseTo(0.1);
    expect(saved.descriptor[1]).toBeCloseTo(0.2);
    expect(saved.descriptor[2]).toBeCloseTo(0.3);
    expect(db.count()).toBe(1);

    const updated = db.update('master', [0.4, 0.5, 0.6]);
    expect(updated?.descriptor).toEqual([0.4, 0.5, 0.6]);
    expect(db.get('master')?.descriptor).toEqual([0.4, 0.5, 0.6]);
    expect(db.getRecords()).toHaveLength(1);

    expect(db.remove('master')).toBe(true);
    expect(db.get('master')).toBeNull();
    expect(db.remove('master')).toBe(false);

    db.close();
  });

  test('save should upsert records by name', () => {
    const { db } = createTempDb();

    db.save('master', [1, 2, 3]);
    db.save('master', [4, 5, 6]);

    expect(db.count()).toBe(1);
    expect(db.get('master')?.descriptor).toEqual([4, 5, 6]);

    db.close();
  });
});
