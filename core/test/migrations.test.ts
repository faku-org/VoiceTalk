import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMigrations, migrate, openDb } from '../src/db/index.ts'
import { scratch } from './helpers.ts'

const tables = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((r) => r.name)

describe('migrations', () => {
  test('the shipped migrations create documents and chunks, in order', () => {
    const db = openDb(':memory:')
    expect(tables(db)).toEqual(
      expect.arrayContaining(['documents', 'chunks', 'schema_migrations']),
    )
    const versions = db
      .query<{ version: number }, []>('SELECT version FROM schema_migrations')
      .all()
    expect(versions.map((v) => v.version)).toEqual(
      loadMigrations().map((m) => m.version),
    )
  })

  test('re-running applies nothing; later migrations are picked up (Phase 3 path)', () => {
    const db = new Database(':memory:')
    const first = [
      { version: 1, name: 'a', sql: 'CREATE TABLE a (id INTEGER)' },
    ]
    expect(migrate(db, first)).toEqual([1])
    expect(migrate(db, first)).toEqual([])
    const more = [
      ...first,
      {
        version: 2,
        name: 'b',
        sql: 'CREATE TABLE b (id INTEGER); CREATE INDEX b_id ON b(id);',
      },
    ]
    expect(migrate(db, more)).toEqual([2])
    expect(tables(db)).toEqual(expect.arrayContaining(['a', 'b']))
  })

  test('a failing migration rolls back and is not recorded', () => {
    const db = new Database(':memory:')
    const bad = [
      {
        version: 1,
        name: 'bad',
        sql: 'CREATE TABLE t (id INTEGER); INSERT INTO nope VALUES (1);',
      },
    ]
    expect(() => migrate(db, bad)).toThrow()
    expect(tables(db)).not.toContain('t')
    expect(db.query('SELECT * FROM schema_migrations').all()).toEqual([])
  })

  test('an applied migration that changed is an error', () => {
    const db = new Database(':memory:')
    migrate(db, [{ version: 1, name: 'a', sql: 'CREATE TABLE a (id INTEGER)' }])
    expect(() =>
      migrate(db, [{ version: 1, name: 'a', sql: 'CREATE TABLE a (id TEXT)' }]),
    ).toThrow(/changed/)
  })

  test('loadMigrations rejects bad names and duplicate versions', () => {
    const s = scratch()
    try {
      writeFileSync(join(s.dir, '0001_a.sql'), 'SELECT 1')
      writeFileSync(join(s.dir, 'notes.txt'), 'ignored')
      expect(loadMigrations(s.dir).map((m) => m.version)).toEqual([1])
      writeFileSync(join(s.dir, '0001_b.sql'), 'SELECT 1')
      expect(() => loadMigrations(s.dir)).toThrow(/Duplicate/)
      writeFileSync(join(s.dir, '0001_b.sql'), 'SELECT 1')
      writeFileSync(join(s.dir, '2_typo.sql'), 'SELECT 1')
      expect(() => loadMigrations(s.dir)).toThrow()
    } finally {
      s.cleanup()
    }
  })

  test('openDb on disk persists, uses WAL and foreign keys', () => {
    const s = scratch()
    try {
      const db = openDb(s.dir)
      expect(
        db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
          ?.journal_mode,
      ).toBe('wal')
      expect(
        db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()
          ?.foreign_keys,
      ).toBe(1)
      db.run(
        "INSERT INTO documents (path, mtime, size, hash, indexed_at) VALUES ('p', 1, 1, 'h', 1)",
      )
      db.close()
      const again = openDb(s.dir)
      expect(
        again
          .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM documents')
          .get()?.n,
      ).toBe(1)
      again.close()
    } finally {
      s.cleanup()
    }
  })
})
