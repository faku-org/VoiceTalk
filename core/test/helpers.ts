import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocInput, Embedder } from '../src/rag/index.ts'

const DIMS = 256

function hashToken(token: string): number {
  let h = 2166136261
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % DIMS
}

/** Deterministic bag-of-words embedding: texts sharing words are close in cosine. No model, no network. */
export function bagOfWords(text: string): Float32Array {
  const v = new Float32Array(DIMS)
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    v[hashToken(token)]! += 1
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

export class FakeEmbedder implements Embedder {
  calls = 0
  up = true
  async embedDocuments(docs: DocInput[]) {
    if (!this.up) throw new Error('down')
    this.calls += docs.length
    return docs.map((d) => bagOfWords(`${d.heading} ${d.text}`))
  }
  async embedQuery(q: string) {
    if (!this.up) throw new Error('down')
    return bagOfWords(q)
  }
  async health() {
    return this.up
  }
}

/** A scratch dir under the OS temp folder, removed by `cleanup`. */
export function scratch(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'vt-test-'))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
