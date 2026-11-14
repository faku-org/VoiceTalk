import { describe, expect, test } from 'bun:test'
import { BruteForceVectorStore, fromBlob, toBlob } from '../src/rag/index.ts'
import { bagOfWords } from './helpers.ts'

const item = (chunkId: number, docId: number, text: string) => ({
  chunkId,
  docId,
  vector: bagOfWords(text),
})

describe('BruteForceVectorStore', () => {
  const store = new BruteForceVectorStore()
  store.replaceDoc(1, [
    item(10, 1, 'meeting notes about the quarterly budget'),
    item(11, 1, 'grocery list milk eggs bread'),
  ])
  store.replaceDoc(2, [
    item(20, 2, 'budget forecast and quarterly revenue'),
    item(21, 2, 'holiday trip to the mountains'),
  ])

  test('ranks by cosine, best first', () => {
    const hits = store.search(bagOfWords('quarterly budget'), 4)
    expect(
      hits
        .map((h) => h.chunkId)
        .slice(0, 2)
        .sort(),
    ).toEqual([10, 20])
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score)
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score)
    expect(hits.at(-1)!.score).toBeLessThan(0.2)
  })

  test('top-k limits and k<=0 is empty', () => {
    expect(store.search(bagOfWords('budget'), 1)).toHaveLength(1)
    expect(store.search(bagOfWords('budget'), 0)).toEqual([])
  })

  test('replaceDoc swaps a document; removeDoc drops it', () => {
    const s = new BruteForceVectorStore()
    s.replaceDoc(1, [item(1, 1, 'alpha beta')])
    s.replaceDoc(1, [item(2, 1, 'gamma delta')])
    expect(s.size).toBe(1)
    expect(s.search(bagOfWords('gamma delta'), 5)[0]!.chunkId).toBe(2)
    s.removeDoc(1)
    expect(s.size).toBe(0)
  })

  test('vectors of another dimension are skipped, not crashed on', () => {
    const s = new BruteForceVectorStore()
    s.replaceDoc(1, [
      { chunkId: 1, docId: 1, vector: new Float32Array([1, 0, 0]) },
    ])
    expect(s.search(bagOfWords('anything'), 5)).toEqual([])
  })

  test('blob round trip keeps values', () => {
    const v = new Float32Array([0.5, -1.25, 3])
    expect(Array.from(fromBlob(toBlob(v)))).toEqual([0.5, -1.25, 3])
  })
})
