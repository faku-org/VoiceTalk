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
import {
  BruteForceVectorStore,
  createRetriever,
  GemmaEmbedder,
  hydrateStore,
  type Embedder,
  type Retriever,
  type VectorStore,
} from './rag/index.ts'

/** Phase 4 services (storage, ingest, retrieval, Code Mode). GraphQL resolvers receive this as context. */
export interface Services {
  config: StorageConfig
  db: Database
  store: VectorStore
  embedder: Embedder
  retriever: Retriever
  ingester: Ingester
  codemode: Codemode
  close(): void
}

export function createServices(
  config: StorageConfig = loadStorageConfig(),
  overrides: { embedder?: Embedder; db?: Database } = {},
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
  const codemode = createCodemode({
    ctx: { allowlist, retriever },
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
    close() {
      ingester.stop()
      db.close()
    },
  }
}
