// Smoke test of the local Hermes agent through core's client (ADR 0017).
//
//   bun core/scripts/agent-smoke.ts [--url <url>] [--task "<read-only task>"] [--timeout <seconds>]
//
// Without --task it only checks health and capabilities. With --task it starts a run and prints the events.
// Any approval request is DENIED: the smoke test never lets the agent write, run or click. The key comes from
// the voicetalk profile .env (or VT_AGENT_KEY) and is never printed.
import { HermesClient } from '../src/agent/client.ts'
import { DEFAULT_AGENT_URL, readAgentKey } from '../src/agent/profile.ts'

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}...` : one
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const url = flag(argv, '--url') ?? DEFAULT_AGENT_URL
  const task = flag(argv, '--task')
  const timeoutMs = Number(flag(argv, '--timeout') ?? 120) * 1000

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
  const runId = await client.start(task, { sessionKey: 'voicetalk-smoke' })
  console.log(`run started: ${runId}`)
  try {
    for await (const ev of client.events(runId, abort.signal)) {
      switch (ev.type) {
        case 'tool':
          console.log(`tool: ${ev.name} ${clip(ev.preview ?? '', 100)}`)
          break
        case 'approval':
          console.log(
            `approval requested: ${clip(ev.request.description)} -> deny`,
          )
          await client.approve(runId, 'deny', ev.request)
          break
        case 'completed':
          console.log(`completed: ${clip(ev.output, 400)}`)
          break
        case 'failed':
          console.log(`failed: ${clip(ev.error)}`)
          process.exitCode = 1
          break
        case 'cancelled':
          console.log('cancelled')
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
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
