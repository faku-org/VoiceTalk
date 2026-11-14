import { EmbedderClient } from '@wefaber/embed'

export interface DocInput {
  heading: string
  text: string
}

/** What ingest and retrieval need from an embedding model. Tests use a deterministic fake. */
export interface Embedder {
  embedDocuments(docs: DocInput[]): Promise<Float32Array[]>
  embedQuery(query: string): Promise<Float32Array>
  health(): Promise<boolean>
}

/**
 * EmbeddingGemma over `@wefaber/embed` (llama-server `--embedding`, OpenAI-compatible). EmbeddingGemma is trained
 * with task prompts: queries as `task: search result | query: …`, documents as `title: … | text: …`. Mixing the
 * two sides is what gives asymmetric retrieval its quality, so the prompts live here and nowhere else.
 */
export class GemmaEmbedder implements Embedder {
  readonly #client: EmbedderClient

  constructor(options: { url: string; model: string; fetch?: typeof fetch }) {
    this.#client = new EmbedderClient({
      baseUrl: options.url,
      model: options.model,
      fetch: options.fetch,
    })
  }

  async embedDocuments(docs: DocInput[]): Promise<Float32Array[]> {
    const texts = docs.map(
      (d) => `title: ${d.heading.trim() || 'none'} | text: ${d.text}`,
    )
    const out = await this.#client.embedMany(texts, { batchSize: 16 })
    return out.map((v) => Float32Array.from(v))
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const v = await this.#client.embed(`task: search result | query: ${query}`)
    return Float32Array.from(v)
  }

  health(): Promise<boolean> {
    return this.#client.health()
  }
}
