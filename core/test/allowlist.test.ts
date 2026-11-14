import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createAllowlist, type Allowlist } from '../src/codemode/index.ts'
import { scratch } from './helpers.ts'

const s = scratch()
const root = join(s.dir, 'allowed')
const secret = join(s.dir, 'outside')
let list: Allowlist
let junctionOk = true
let fileLinkOk = true

beforeAll(() => {
  mkdirSync(join(root, 'sub'), { recursive: true })
  mkdirSync(secret, { recursive: true })
  writeFileSync(join(root, 'a.md'), 'inside')
  writeFileSync(join(root, 'sub', 'b.md'), 'inside too')
  writeFileSync(join(secret, 'secret.md'), 'outside')
  // A sibling that shares the root's name as a prefix must not pass a naive startsWith check.
  mkdirSync(`${root}-evil`)
  writeFileSync(join(`${root}-evil`, 'x.md'), 'evil')
  // Junctions need no privilege on Windows; on POSIX they are plain symlinks.
  try {
    symlinkSync(secret, join(root, 'jump'), 'junction')
  } catch {
    junctionOk = false
  }
  // File symlinks need Developer Mode or admin on Windows.
  try {
    symlinkSync(join(secret, 'secret.md'), join(root, 'jump.md'), 'file')
  } catch {
    fileLinkOk = false
  }
  list = createAllowlist([root])
})
afterAll(() => s.cleanup())

const denied = (input: string) =>
  expect(list.resolve(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })

describe('allowlist', () => {
  test('allows files inside, absolute or relative', async () => {
    expect(await list.resolve(join(root, 'a.md'))).toContain('a.md')
    expect(await list.resolve('a.md')).toContain('a.md')
    expect(await list.resolve(`sub${sep}b.md`)).toContain('b.md')
    expect(await list.resolve(root)).toBeTruthy()
  })

  test('denies parent segments, however spelled', async () => {
    await denied('..')
    await denied(`..${sep}outside${sep}secret.md`)
    await denied('sub/../../outside/secret.md')
    await denied(`${root}${sep}..${sep}outside${sep}secret.md`)
    await denied('sub\\..\\..\\outside\\secret.md')
  })

  test('denies absolute paths outside the allowlist', async () => {
    await denied(join(secret, 'secret.md'))
    await denied(`${root}-evil${sep}x.md`)
    await denied(
      process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd',
    )
    await denied(process.platform === 'win32' ? 'C:\\' : '/')
  })

  test('denies UNC and device paths', async () => {
    await denied('\\\\server\\share\\file.md')
    await denied('//server/share/file.md')
    await denied('\\\\?\\C:\\Windows\\win.ini')
    await denied('\\\\.\\PhysicalDrive0')
    await denied('\\\\localhost\\c$\\Windows\\win.ini')
  })

  test('denies empty, NUL, drive-relative and ADS paths', async () => {
    await denied('')
    await denied('   ')
    await denied('a.md\u0000.png')
    await denied('C:secret.md')
    await denied('a.md:hidden')
  })

  test('denies a symlink or junction that points outside', async () => {
    if (!junctionOk) return console.warn('junctions unavailable, skipped')
    await denied(join(root, 'jump', 'secret.md'))
    await denied('jump/secret.md')
    await denied('jump')
  })

  test('denies a file symlink that points outside', async () => {
    if (!fileLinkOk) return console.warn('file symlinks unavailable, skipped')
    await denied('jump.md')
  })

  test('inside but missing is NOT_FOUND, not FORBIDDEN', async () => {
    expect(list.resolve('nope.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('without existing folders nothing resolves', async () => {
    const empty = createAllowlist([join(s.dir, 'missing')])
    expect(empty.roots[0]!.real).toBeNull()
    expect(empty.resolve('a.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
