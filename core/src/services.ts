import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import {
  AUDIT_FILE,
  createAllowlist,
  createCodemode,
  type Codemode,
} from './codemode/index.ts'
import { loadStorageConfig, openDb, type StorageConfig } from './db/index.ts'
import { Ingester } from './ingest/index.ts'
import { liveChat } from './call/live.ts'
import {
  loadLlmConfig,
  normalizeBaseUrl,
  OpenAiCompatChat,
  type ChatProvider,
} from './llm/index.ts'
import { createNotesService, type NotesService } from './notes/index.ts'
import { getPrefsStore } from './prefs/store.ts'
import {
  BruteForceVectorStore,
  createRetriever,
  GemmaEmbedder,
  hydrateStore,
  type Embedder,
  type Retriever,
  type VectorStore,
} from './rag/index.ts'

/** Phase 4 + 3 services (storage, ingest, retrieval, Code Mode, sessions and notes). GraphQL resolvers receive this as context. */
export interface Services {
  config: StorageConfig
  db: Database
  store: VectorStore
  embedder: Embedder
  retriever: Retriever
  ingester: Ingester
  codemode: Codemode
  notes: NotesService
  close(): void
}

export function createServices(
  config: StorageConfig = loadStorageConfig(),
  overrides: {
    embedder?: Embedder
    db?: Database
    /** Decision/summary model. Defaults to the local llama-server; never the cloud brain. */
    llm?: ChatProvider | null
  } = {},
): Services {
  const db = overrides.db ?? openDb(config.dataDir)
  const store = new BruteForceVectorStore()
  hydrateStore(db, store)
  const embedder =
    overrides.embedder ??
    new GemmaEmbedder({ url: config.embedUrl, model: config.embedModel })
  const allowlist = createAllowlist(config.folders)
  const retriever = createRetriever({ db, store, embedder })
  const ingester = new Ingester({ db, store, embedder, allowlist })
  const llmConfig = loadLlmConfig()
  // Local decision model; follows prefs.llmUrl (falls back to env when prefs are unreadable). Cached per URL.
  let decisionUrl: string | null = null
  let decision: ChatProvider | null = null
  const liveDecisionLlm = (): ChatProvider =>
    liveChat(() => {
      let url = llmConfig.llmUrl
      try {
        url = normalizeBaseUrl(getPrefsStore().get().llmUrl)
      } catch {
        // keep the env URL
      }
      if (decision === null || url !== decisionUrl) {
        decision = new OpenAiCompatChat({
          baseUrl: url,
          model: llmConfig.llmModel,
          temperature: 0,
        })
        decisionUrl = url
      }
      return decision
    })
  const notes = createNotesService({
    db,
    embedder,
    llm: overrides.llm === undefined ? liveDecisionLlm() : overrides.llm,
    prefs: () => {
      const p = getPrefsStore().get()
      return {
        threshold: p.thresholds.respondConfidence,
        location: p.location.manual,
      }
    },
  })
  const codemode = createCodemode({
    ctx: { allowlist, retriever, notes: notes.search },
    auditPath: join(config.dataDir, AUDIT_FILE),
  })
  return {
    config,
    db,
    store,
    embedder,
    retriever,
    ingester,
    codemode,
    notes,
    close() {
      ingester.stop()
      db.close()
    },
  }
}
