import { OpError } from '@wefaber/codemode'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export interface AllowRoot {
  /** As configured (resolved, not realpath'd). */
  configured: string
  /** Real path, `null` when the folder does not exist. */
  real: string | null
}

export interface Allowlist {
  readonly roots: readonly AllowRoot[]
  /**
   * Resolves an agent-supplied path to a real path inside an allowlisted folder, or throws `OpError`:
   * `FORBIDDEN` for anything outside or suspicious, `NOT_FOUND` when it is inside but does not exist.
   * Relative paths resolve against the first folder.
   */
  resolve(input: string): Promise<string>
  /** Lexical containment (same rules as `resolve`, no I/O). */
  isInside(root: string, path: string): boolean
}

const deny = (why: string): never => {
  throw new OpError('FORBIDDEN', `Path not allowed: ${why}`)
}

function inside(root: string, path: string): boolean {
  // path.relative is case-insensitive on win32; a result that climbs or jumps drive is outside.
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Rejects, before touching the filesystem: empty paths, NUL, `..` segments, UNC and device paths
 * (`\\server\share`, `//server`, `\\?\`, `\\.\`), drive-relative paths (`C:foo`), and `:` after the drive
 * (NTFS alternate data streams).
 */
function lexicalCheck(input: string): void {
  if (typeof input !== 'string' || input.trim() === '') deny('empty path')
  if (input.includes('\u0000')) deny('NUL byte')
  if (/^[\\/]{2}/.test(input)) deny('UNC or device path')
  if (input.split(/[\\/]+/).some((seg) => seg === '..'))
    deny('parent segment (..)')
  if (/^[a-zA-Z]:(?![\\/])/.test(input)) deny('drive-relative path')
  if (input.slice(/^[a-zA-Z]:/.test(input) ? 2 : 0).includes(':'))
    deny('alternate data stream')
}

export function createAllowlist(folders: readonly string[]): Allowlist {
  const roots: AllowRoot[] = folders.map((f) => {
    const configured = resolve(f)
    let real: string | null
    try {
      real = realpathSync.native(configured)
    } catch {
      real = null
    }
    return { configured, real }
  })

  return {
    roots,
    isInside: inside,
    async resolve(input) {
      lexicalCheck(input)
      const base = roots.find((r) => r.real !== null)
      if (!base) throw new OpError('NOT_FOUND', 'No allowlisted folder exists')
      const candidate = isAbsolute(input)
        ? resolve(input)
        : resolve(base.real!, input)
      if (/^[\\/]{2}/.test(candidate)) deny('UNC or device path')
      const lexOk = roots.some(
        (r) =>
          inside(r.configured, candidate) ||
          (r.real !== null && inside(r.real, candidate)),
      )
      if (!lexOk) deny('outside the allowlisted folders')
      let real: string
      try {
        real = await realpath(candidate)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          throw new OpError('NOT_FOUND', `No such file: ${input}`)
        return deny('cannot resolve')
      }
      // The real path decides: a symlink or junction inside the folder that points out is denied here.
      if (!roots.some((r) => r.real !== null && inside(r.real, real)))
        deny('resolves outside the allowlisted folders')
      return real
    },
  }
}
