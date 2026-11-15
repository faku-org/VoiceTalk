// Smoke test of the Hermes agent through core's client (ADR 0017).
//
//   bun core/scripts/agent-smoke.ts [--url <url>] [--task "<task>"] [--provider openrouter|local] [--model <id>]
//                                   [--approve-matching "<regex>"] [--timeout <seconds>]
//
// Without --task it only checks health and capabilities. With --task it starts a run through the same call the app
// makes (per-run provider and model) and prints the events with timings and token usage.
// Every approval request is DENIED unless its description or command matches --approve-matching (a deliberate,
// narrow opt-in, e.g. "notepad"); the smoke test never lets the agent write, run or click anything else.
// The keys come from the voicetalk profile .env or the environment and are never printed.
import { HermesClient } from '../src/agent/client.ts'
import {
  AGENT_PROVIDERS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_URL,
  readAgentKey,
  type AgentProvider,
} from '../src/agent/profile.ts'

/** Provider ids as Hermes names them (core/src/agent/service.ts uses the same map). */
const HERMES_PROVIDER: Record<AgentProvider, string> = {
  local: 'custom',
  openrouter: 'openrouter',
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}...` : one
}

const seconds = (since: number): string =>
  `${((performance.now() - since) / 1000).toFixed(1)}s`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const url = flag(argv, '--url') ?? DEFAULT_AGENT_URL
  const task = flag(argv, '--task')
  const timeoutMs = Number(flag(argv, '--timeout') ?? 120) * 1000
  const provider = (flag(argv, '--provider') ??
    DEFAULT_AGENT_PROVIDER) as AgentProvider
  if (!AGENT_PROVIDERS.includes(provider)) {
    throw new Error(`--provider must be one of ${AGENT_PROVIDERS.join(', ')}`)
  }
  const model =
    flag(argv, '--model') ??
    (provider === 'openrouter' ? DEFAULT_AGENT_MODEL : undefined)
  const approveFilter = flag(argv, '--approve-matching')
  const approve = approveFilter ? new RegExp(approveFilter, 'i') : null

  const key = readAgentKey()
  if (!key) throw new Error('No API key: run `bun run agent:profile` first')
  const client = new HermesClient({ baseUrl: url, key })

  const health = await client.health()
  console.log(`health: ${health.ok ? 'ok' : `down (${health.reason ?? '?'})`}`)
  if (!health.ok) process.exit(1)

  const caps = await client.capabilities()
  console.log(`capabilities: runs=${caps.runs} approval=${caps.approval}`)
  if (!task) return

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const t0 = performance.now()
  const runId = await client.start(task, {
    sessionKey: 'voicetalk-smoke',
    provider: HERMES_PROVIDER[provider],
    ...(model ? { model } : {}),
  })
  console.log(
    `run started: ${runId} (provider ${provider}, model ${model ?? 'profile default'})`,
  )
  try {
    for await (const ev of client.events(runId, abort.signal)) {
      const at = `[${seconds(t0)}]`
      switch (ev.type) {
        case 'tool':
          console.log(`${at} tool: ${ev.name} ${clip(ev.preview ?? '', 100)}`)
          break
        case 'tool_done':
          console.log(
            `${at} tool done: ${ev.name}${ev.failed ? ' (failed)' : ''}`,
          )
          break
        case 'approval': {
          const text = `${ev.request.description} ${ev.request.command ?? ''}`
          const yes = approve?.test(text) === true
          console.log(
            `${at} approval requested: ${clip(ev.request.description)} -> ${yes ? 'approve once' : 'deny'}`,
          )
          await client.approve(runId, yes ? 'once' : 'deny', ev.request)
          break
        }
        case 'completed': {
          console.log(`${at} completed: ${clip(ev.output, 600)}`)
          const u = ev.usage
          console.log(
            u
              ? `tokens: input ${u.inputTokens}, output ${u.outputTokens}, cache read ${u.cacheReadTokens}`
              : 'tokens: not reported by Hermes',
          )
          break
        }
        case 'failed':
          console.log(`${at} failed: ${clip(ev.error, 600)}`)
          process.exitCode = 1
          break
        case 'cancelled':
          console.log(`${at} cancelled`)
          break
        default:
          break
      }
    }
  } catch (err) {
    console.log(`stopped: ${err instanceof Error ? err.message : String(err)}`)
    await client.stop(runId).catch(() => undefined)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
  }
  console.log(`total: ${seconds(t0)}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
