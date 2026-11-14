/**
 * Dev launcher: `bun dev` runs `tauri dev`; `bun dev --local` first starts the local models
 * (llama-server for the LLM and the embedder), waits for their health, then runs `tauri dev`
 * and stops the servers it started when the app exits.
 *
 * Bun loads `.env` and `.env.local` from the repo root before this runs, and the Tauri shell
 * passes the environment on to the sidecars. Keys are never printed, only whether they are set.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Subprocess } from 'bun'

const ROOT = resolve(import.meta.dir, '..', '..')
const HUB = join(homedir(), '.cache', 'huggingface', 'hub')
const HEALTH_TIMEOUT_MS = 180_000

const DEFAULT_LLM_URL = 'http://127.0.0.1:8080/v1'
const DEFAULT_EMBED_URL = 'http://127.0.0.1:8891/v1/embeddings'
const DEFAULT_LLM_GGUF = ['LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-Q4_K_M.gguf']
const DEFAULT_EMBED_GGUF = [
  'ggml-org/embeddinggemma-2-GGUF',
  'embeddinggemma-2-Q8_0.gguf',
]

interface ModelServer {
  name: string
  origin: string
  port: number
  model: string
  extraArgs: string[]
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

/** Path from the env var, else the file in the Hugging Face cache, else undefined. */
function resolveGguf(
  varName: string,
  [repo, file]: string[],
): string | undefined {
  const explicit = env(varName)
  if (explicit) return existsSync(explicit) ? resolve(explicit) : undefined
  const snaps = join(HUB, `models--${repo!.replace('/', '--')}`, 'snapshots')
  if (!existsSync(snaps)) return undefined
  for (const snap of readdirSync(snaps)) {
    const p = join(snaps, snap, file!)
    if (existsSync(p)) return p
  }
  return undefined
}

function originOf(url: string): { origin: string; port: number } {
  const u = new URL(url)
  return { origin: u.origin, port: Number(u.port || 80) }
}

async function healthy(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function startServer(s: ModelServer): Promise<Subprocess | null> {
  if (await healthy(s.origin)) {
    console.log(`[dev] ${s.name}: already running on ${s.origin}, reusing it`)
    return null
  }
  const bin = env('VT_LLAMA_SERVER') ?? 'llama-server'
  const args = [
    bin,
    '-m',
    s.model,
    '--host',
    '127.0.0.1',
    '--port',
    String(s.port),
    ...(env('VT_LLAMA_ARGS')?.split(/\s+/) ?? ['-ngl', '99']),
    ...s.extraArgs,
  ]
  console.log(`[dev] ${s.name}: starting ${bin} on :${s.port}`)
  const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe' })
  const t0 = performance.now()
  while (!(await healthy(s.origin))) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`${s.name}: llama-server exited\n${err.slice(-2000)}`)
    }
    if (performance.now() - t0 > HEALTH_TIMEOUT_MS) {
      proc.kill()
      throw new Error(
        `${s.name}: no health after ${HEALTH_TIMEOUT_MS / 1000} s`,
      )
    }
    await Bun.sleep(500)
  }
  console.log(
    `[dev] ${s.name}: ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  )
  return proc
}

function localServers(): ModelServer[] {
  const llmModel = resolveGguf('VT_LLM_GGUF', DEFAULT_LLM_GGUF)
  const embedModel = resolveGguf('VT_EMBED_GGUF', DEFAULT_EMBED_GGUF)
  const missing = [
    !llmModel && 'VT_LLM_GGUF (LFM3-1.7B-Q4_K_M.gguf)',
    !embedModel && 'VT_EMBED_GGUF (embeddinggemma-2-Q8_0.gguf)',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(
      `model file not found: ${missing.join(', ')}. Set the path in .env.local.`,
    )
  }
  const llm = originOf(env('VT_LLM_URL') ?? DEFAULT_LLM_URL)
  const embed = originOf(env('VT_EMBED_URL') ?? DEFAULT_EMBED_URL)
  return [
    {
      name: 'llm',
      ...llm,
      model: llmModel!,
      extraArgs: ['-c', '8192', '--jinja'],
    },
    { name: 'embed', ...embed, model: embedModel!, extraArgs: ['--embedding'] },
  ]
}

// `.env.local` keeps every variable as a placeholder; an empty one means "use the default",
// so drop it before the sidecars read it (voice would take `VT_GLOSSARY=` as a path).
for (const [k, v] of Object.entries(process.env)) {
  if ((k.startsWith('VT_') || k.endsWith('_API_KEY')) && !v?.trim()) {
    delete process.env[k]
  }
}

const local = process.argv.includes('--local')
const started: Subprocess[] = []
const stopAll = async () => {
  for (const p of started) p.kill()
  await Promise.all(started.map((p) => p.exited))
}

const setKeys = ['CARTESIA_API_KEY', 'ANTHROPIC_API_KEY'].map(
  (k) => `${k}=${env(k) ? 'set' : 'missing'}`,
)
console.log(
  `[dev] ${local ? 'local models' : 'app only'} · ${setKeys.join(' · ')}`,
)

try {
  if (local) {
    process.env.VT_BRAIN ??= 'local'
    process.env.VT_LLM_URL ??= DEFAULT_LLM_URL
    process.env.VT_EMBED_URL ??= DEFAULT_EMBED_URL
    for (const s of localServers()) {
      const proc = await startServer(s)
      if (proc) started.push(proc)
    }
  }
} catch (err) {
  await stopAll()
  console.error(`[dev] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const tauri = Bun.spawn(['bun', 'run', 'tauri', 'dev'], {
  cwd: ROOT,
  stdio: ['inherit', 'inherit', 'inherit'],
  env: process.env,
})
const forward = () => tauri.kill()
process.on('SIGINT', forward)
process.on('SIGTERM', forward)

const code = await tauri.exited
await stopAll()
process.exit(code)
