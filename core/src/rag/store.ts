import { cosine } from '@wefaber/embed'

export interface VectorItem {
  chunkId: number
  docId: number
  vector: Float32Array
}

export interface VectorHit {
  chunkId: number
  docId: number
  score: number
}

/**
 * Where chunk embeddings are searched. The brute-force store is enough for a personal folder (tens of thousands
 * of chunks); an ANN index (sqlite-vec, HNSW) can replace it behind this interface.
 */
export interface VectorStore {
  /** Replaces every vector of `docId` with `items`. */
  replaceDoc(docId: number, items: VectorItem[]): void
  removeDoc(docId: number): void
  /** Top `k` by cosine, highest first. Ties keep insertion order. */
  search(query: Float32Array, k: number): VectorHit[]
  readonly size: number
}

// `cosine` from @wefaber/embed only indexes and reads `length`, so a Float32Array is safe to pass.
const sim = (a: Float32Array, b: Float32Array) =>
  cosine(a as unknown as readonly number[], b as unknown as readonly number[])

export class BruteForceVectorStore implements VectorStore {
  readonly #byDoc = new Map<number, VectorItem[]>()

  get size(): number {
    let n = 0
    for (const items of this.#byDoc.values()) n += items.length
    return n
  }

  replaceDoc(docId: number, items: VectorItem[]): void {
    if (items.length === 0) this.#byDoc.delete(docId)
    else this.#byDoc.set(docId, items)
  }

  removeDoc(docId: number): void {
    this.#byDoc.delete(docId)
  }

  search(query: Float32Array, k: number): VectorHit[] {
    if (k <= 0) return []
    const hits: VectorHit[] = []
    for (const items of this.#byDoc.values()) {
      for (const item of items) {
        if (item.vector.length !== query.length) continue
        hits.push({
          chunkId: item.chunkId,
          docId: item.docId,
          score: sim(query, item.vector),
        })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: SQLite buffers are not guaranteed to be 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}
