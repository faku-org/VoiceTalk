import type { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One SQL migration file: `NNNN_snake_name.sql`, applied in ascending `version` order. */
export interface Migration {
  version: number
  name: string
  sql: string
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/

export const MIGRATIONS_DIR = join(import.meta.dir, 'migrations')

/**
 * Reads the migration files of `dir`. Any other file is ignored; a duplicate version or a `.sql` file that does
 * not match the naming rule is an error, so a typo cannot silently skip a migration.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue
    const m = FILE.exec(file)
    if (!m) throw new Error(`Migration file name invalid: ${file}`)
    out.push({
      version: Number(m[1]),
      name: m[2]!,
      sql: readFileSync(join(dir, file), 'utf8'),
    })
  }
  out.sort((a, b) => a.version - b.version)
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.version === out[i - 1]!.version)
      throw new Error(`Duplicate migration version ${out[i]!.version}`)
  }
  return out
}

function checksum(sql: string): string {
  return new Bun.CryptoHasher('sha256').update(sql).digest('hex')
}

/**
 * Applies the pending migrations, each in its own transaction, and records them in `schema_migrations`.
 * An applied migration whose file changed afterwards is an error: migrations are append-only (expand/contract),
 * a fix is a new file. Returns the versions applied by this call.
 */
export function migrate(
  db: Database,
  migrations: Migration[] = loadMigrations(),
): number[] {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)
  const applied = new Map<number, string>()
  for (const row of db
    .query<{ version: number; checksum: string }, []>(
      'SELECT version, checksum FROM schema_migrations',
    )
    .all())
    applied.set(row.version, row.checksum)

  const done: number[] = []
  for (const m of migrations) {
    const sum = checksum(m.sql)
    const prev = applied.get(m.version)
    if (prev !== undefined) {
      if (prev !== sum)
        throw new Error(
          `Migration ${m.version}_${m.name} changed after it was applied`,
        )
      continue
    }
    db.transaction(() => {
      db.run(m.sql)
      db.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [m.version, m.name, sum, Date.now()],
      )
    })()
    done.push(m.version)
  }
  return done
}
