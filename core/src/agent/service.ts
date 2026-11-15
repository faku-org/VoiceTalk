import { getPrefsStore } from '../prefs/store.ts'
import { HermesClient } from './client.ts'
import {
  localProfileProblem,
  readAgentKey,
  readOpenRouterKey,
  readProfileModel,
  type AgentProvider,
  type ProfileModel,
} from './profile.ts'
import {
  AgentError,
  type AgentEvent,
  type ApprovalChoice,
  type ApprovalRequest,
} from './types.ts'

export interface AgentStatus {
  /** The `agent.enabled` pref. */
  enabled: boolean
  /** An API key for the profile was found (value never exposed). */
  hasKey: boolean
  online: boolean
  reason: string | null
}

/** One task running in Hermes. Events go to the sink given to `run`. */
export interface AgentRunHandle {
  readonly runId: string
  /** The approval currently waiting for the user, if any. */
  readonly pending: ApprovalRequest | undefined
  /** Answers the pending approval. No-op when nothing is pending. */
  answer(choice: ApprovalChoice): Promise<void>
  /** Interrupts the run. */
  stop(): Promise<void>
  /** Detaches without stopping (call ended): the stream is dropped, Hermes keeps its own state. */
  detach(): void
  /** Resolves when the run reached a terminal event or the stream was lost. */
  readonly done: Promise<void>
}

/** What the call loop sees of the agent: a port, so tests can fake it. */
export interface AgentPort {
  /** Enabled in prefs. Cheap; no network. */
  enabled(): boolean
  /** Reachable and authorized right now. Never throws. */
  status(): Promise<AgentStatus>
  /** Starts a task. Throws `AgentError` when Hermes is unreachable. */
  run(
    task: string,
    sink: (ev: AgentEvent) => void,
    opts?: { sessionKey?: string },
  ): Promise<AgentRunHandle>
}

export interface AgentServiceDeps {
  /** Live prefs, read on every call so the Preferencias changes apply without a restart. */
  prefs: () => {
    enabled: boolean
    provider: AgentProvider
    url: string
    model: string
  }
  key: () => string | undefined
  /** OpenRouter key, only asked for when the provider is `openrouter`. Never exposed. */
  openRouterKey?: () => string | undefined
  /**
   * Model block of the profile config, asked for when the provider is `local`. A profile set up for OpenRouter
   * would send a `local` run to openrouter.ai, so such a run is refused. Left out, nothing is checked.
   */
  profileModel?: () => ProfileModel | undefined
  fetch?: typeof fetch
}

/** The Hermes provider id each pref value pins a run to, so a run never falls through to the other one. */
const HERMES_PROVIDER: Record<AgentProvider, string> = {
  openrouter: 'openrouter',
  local: 'custom',
}

export function createAgentService(deps: AgentServiceDeps): AgentPort {
  let cached: { url: string; key: string; client: HermesClient } | null = null
  const clientFor = (url: string, key: string): HermesClient => {
    if (cached && cached.url === url && cached.key === key) return cached.client
    const client = new HermesClient({ baseUrl: url, key, fetch: deps.fetch })
    cached = { url, key, client }
    return client
  }

  const localProblem = (provider: AgentProvider): string | null =>
    provider === 'local' && deps.profileModel
      ? localProfileProblem(deps.profileModel())
      : null

  return {
    enabled: () => deps.prefs().enabled,

    async status(): Promise<AgentStatus> {
      const { enabled, url, provider } = deps.prefs()
      const key = deps.key()
      if (!enabled) {
        return {
          enabled,
          hasKey: Boolean(key),
          online: false,
          reason: 'Agente desactivado',
        }
      }
      if (!key) {
        return {
          enabled,
          hasKey: false,
          online: false,
          reason: 'Falta la API key del perfil',
        }
      }
      if (provider === 'openrouter' && !deps.openRouterKey?.()) {
        return {
          enabled,
          hasKey: true,
          online: false,
          reason: 'Falta OPENROUTER_API_KEY',
        }
      }
      const problem = localProblem(provider)
      if (problem) {
        return { enabled, hasKey: true, online: false, reason: problem }
      }
      const health = await clientFor(url, key).health()
      return {
        enabled,
        hasKey: true,
        online: health.ok,
        reason: health.reason ?? null,
      }
    },

    async run(task, sink, opts = {}) {
      const { enabled, url, model, provider } = deps.prefs()
      const key = deps.key()
      if (!enabled) throw new AgentError('Agent disabled')
      if (!key) throw new AgentError('Hermes API key not found')
      if (provider === 'openrouter' && !deps.openRouterKey?.()) {
        throw new AgentError('OPENROUTER_API_KEY not found')
      }
      const problem = localProblem(provider)
      if (problem) throw new AgentError(problem)
      const client = clientFor(url, key)
      const runId = await client.start(task, {
        sessionKey: opts.sessionKey,
        model: model || undefined,
        provider: HERMES_PROVIDER[provider],
      })
      const abort = new AbortController()
      let pending: ApprovalRequest | undefined

      const pump = async (): Promise<void> => {
        let terminal = false
        try {
          for await (const ev of client.events(runId, abort.signal)) {
            if (ev.type === 'approval') pending = ev.request
            else if (ev.type === 'approval_settled') pending = undefined
            if (
              ev.type === 'completed' ||
              ev.type === 'failed' ||
              ev.type === 'cancelled'
            ) {
              terminal = true
            }
            sink(ev)
          }
          if (!terminal && !abort.signal.aborted) {
            sink({
              type: 'failed',
              error: 'Se perdió la conexión con el agente',
            })
          }
        } catch (err) {
          if (!abort.signal.aborted)
            sink({ type: 'failed', error: (err as Error).message })
        } finally {
          pending = undefined
        }
      }

      const done = pump()
      return {
        runId,
        get pending() {
          return pending
        },
        async answer(choice) {
          const current = pending
          if (!current) return
          pending = undefined
          await client.approve(runId, choice, current)
        },
        stop: () => client.stop(runId),
        detach: () => abort.abort(),
        done,
      }
    },
  }
}

let shared: AgentPort | null = null

/** The service wired to the real prefs and profile key. Tests build their own with `createAgentService`. */
export function getAgentService(): AgentPort {
  shared ??= createAgentService({
    prefs: () => {
      const { agent } = getPrefsStore().get()
      return {
        enabled: agent.enabled,
        provider: agent.provider,
        url: agent.url,
        model: agent.model,
      }
    },
    key: () => readAgentKey(),
    openRouterKey: () => readOpenRouterKey(),
    profileModel: () => readProfileModel(),
  })
  return shared
}
