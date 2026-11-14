import {
  codeOf,
  DEFAULT_LIMITS,
  MAX_CODE_CHARS,
  OpError,
  type HostApi,
  type HostFn,
  type Limits,
  type Sandbox,
  type WcmErrorCode,
} from '@wefaber/codemode'
import { createQuickJsSandbox } from '@wefaber/codemode-sandbox-quickjs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ALIASES, registry, SCOPES, type CodemodeCtx } from './ops.ts'

export const AUDIT_FILE = 'codemode-audit.jsonl'

/** One host call made by the code, in call order. */
export interface TimelineEntry {
  /** Short op name, e.g. `fs.read`. */
  op: string
  /** Milliseconds since the run started. */
  startMs: number
  ms: number
  ok: boolean
  /** `OpError` code of a failed call. */
  code: string | null
  /** Truncated JSON of the arguments (paths and queries; never file contents). */
  args: string
  /** Shape of the result (`array(5)`, `object, 1.2 KB`), not its content. */
  summary: string
}

export interface CodemodeRun {
  ok: boolean
  /** JSON text of what the code returned; `null` when the run failed. */
  resultJson: string | null
  truncated: boolean
  error: { code: WcmErrorCode; message: string } | null
  logs: string[]
  calls: number
  ms: number
  timeline: TimelineEntry[]
}

export interface Codemode {
  run(code: string, origin?: string): Promise<CodemodeRun>
}

const preview = (value: unknown, max: number): string => {
  let s: string
  try {
    s = JSON.stringify(value) ?? 'undefined'
  } catch {
    s = String(value)
  }
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return typeof value
  const size = JSON.stringify(value).length
  return `object, ${size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`}`
}

/** Wraps every host function so each call lands in `timeline` with its duration, args shape and outcome. */
function instrument(
  host: HostApi,
  timeline: TimelineEntry[],
  t0: number,
  prefix = '',
): HostApi {
  const out: HostApi = {}
  for (const [name, entry] of Object.entries(host)) {
    if (typeof entry !== 'function') {
      out[name] = instrument(entry, timeline, t0, `${prefix}${name}.`)
      continue
    }
    const fn: HostFn = entry
    const op = `${prefix}${name}`.replace(/^voicetalk\./, '')
    out[name] = async (...args: unknown[]) => {
      const start = performance.now()
      const item: TimelineEntry = {
        op,
        startMs: Math.round(start - t0),
        ms: 0,
        ok: true,
        code: null,
        args: preview(args[0] ?? {}, 200),
        summary: '',
      }
      timeline.push(item)
      try {
        const result = await fn(...args)
        item.summary = summarize(result)
        return result
      } catch (err) {
        item.ok = false
        item.code = codeOf(err) ?? 'HOST_ERROR'
        throw err
      } finally {
        item.ms = Math.round(performance.now() - start)
      }
    }
  }
  return out
}

/** Serialises appends so concurrent runs never interleave lines. */
function auditWriter(path: string): (line: unknown) => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  return (line) => {
    chain = chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8')
      })
      .catch(() => {})
    return chain
  }
}

export interface CodemodeOptions {
  ctx: CodemodeCtx
  /** Absolute path of the audit JSONL (in the data dir). */
  auditPath: string
  sandbox?: Sandbox
  limits?: Partial<Limits>
}

/**
 * Read-only Code Mode: the agent's JavaScript runs in QuickJS (no network, no process API) and can only call the
 * `voicetalk:read` ops. Every execution appends one line to the audit file: time, origin, the code, the outcome
 * and the call timeline. Results are never logged (they hold personal text); the code and the call arguments are.
 */
export function createCodemode(options: CodemodeOptions): Codemode {
  const sandbox = options.sandbox ?? createQuickJsSandbox()
  const audit = auditWriter(options.auditPath)
  const limits = { ...DEFAULT_LIMITS, ...options.limits }

  return {
    async run(code, origin = 'graphql') {
      const startedAt = Date.now()
      const t0 = performance.now()
      const timeline: TimelineEntry[] = []
      let run: CodemodeRun
      try {
        if (typeof code !== 'string' || code.trim() === '')
          throw new OpError('VALIDATION', 'code is empty')
        if (code.length > MAX_CODE_CHARS)
          throw new OpError(
            'VALIDATION',
            `code is longer than ${MAX_CODE_CHARS} characters`,
          )
        const host = instrument(
          registry.host(SCOPES, options.ctx),
          timeline,
          t0,
        )
        const res = await sandbox.run({
          code,
          host,
          name: 'codemode',
          aliases: ALIASES,
          limits,
        })
        run = res.ok
          ? {
              ok: true,
              resultJson: res.result,
              truncated: res.truncated,
              error: null,
              logs: res.logs,
              calls: res.calls,
              ms: res.ms,
              timeline,
            }
          : {
              ok: false,
              resultJson: null,
              truncated: false,
              // QuickJS reports a deadline hit inside a synchronous loop as CODE_ERROR "interrupted".
              error:
                res.error.code === 'CODE_ERROR' &&
                res.error.message === 'interrupted'
                  ? {
                      code: 'TIMEOUT',
                      message: `Run exceeded ${limits.timeoutMs} ms`,
                    }
                  : res.error,
              logs: res.logs,
              calls: res.calls,
              ms: res.ms,
              timeline,
            }
      } catch (err) {
        run = {
          ok: false,
          resultJson: null,
          truncated: false,
          error: {
            code: (codeOf(err) as WcmErrorCode | undefined) ?? 'HOST_ERROR',
            message: (err as Error).message,
          },
          logs: [],
          calls: timeline.length,
          ms: Math.round(performance.now() - t0),
          timeline,
        }
      }
      await audit({
        ts: new Date(startedAt).toISOString(),
        origin,
        code,
        ok: run.ok,
        error: run.error,
        ms: run.ms,
        calls: run.calls,
        resultChars: run.resultJson?.length ?? 0,
        timeline: run.timeline,
      })
      return run
    },
  }
}
