import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { migrate } from './migrate.ts'

export { loadMigrations, migrate, type Migration } from './migrate.ts'
export { loadStorageConfig, type StorageConfig } from './config.ts'

export const DB_FILE = 'voicetalk.db'

/**
 * Opens (or creates) `<dataDir>/voicetalk.db` with the house pragmas (WAL, foreign keys, busy timeout) and
 * applies pending migrations. Pass `':memory:'` for tests.
 */
export function openDb(dataDir: string | ':memory:'): Database {
  let file: string
  if (dataDir === ':memory:') file = ':memory:'
  else {
    mkdirSync(dataDir, { recursive: true })
    file = join(dataDir, DB_FILE)
  }
  const db = new Database(file, { create: true, strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}
