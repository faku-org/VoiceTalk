// Creates and configures the `voicetalk` Hermes profile (ADR 0017). Repeatable: a rerun only reapplies settings
// and keeps the existing API key.
//
//   bun core/scripts/hermes-profile.ts [--llm-url <url>] [--model <id>] [--port <n>] [--dry-run]
//
// Safety: only the `voicetalk` profile is addressed (assertNotDefault). The default profile's config.yaml, .env
// and gateway are never read or written. The API key goes to the profile .env and is never printed.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SETUP_MODEL,
  DEFAULT_SETUP_PORT,
  configCommands,
  profileEnvValues,
  toolsetCommands,
  validateSetup,
  withProfile,
  API_PLATFORM,
  type ProfileSetup,
} from '../src/agent/setup.ts'
import {
  PROFILE_NAME,
  assertNotDefault,
  hermesBin,
  parseEnv,
  profileDir,
  profileEnvPath,
  upsertEnv,
} from '../src/agent/profile.ts'

const DEFAULT_LLM_URL = 'http://127.0.0.1:8080/v1'

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

async function hermes(bin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(
      `hermes ${args.join(' ')} exited with ${code}\n${(err || out).trim()}`,
    )
  }
  return out
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const setup: ProfileSetup = {
    llmUrl:
      flag(argv, '--llm-url') ?? process.env.VT_LLM_URL ?? DEFAULT_LLM_URL,
    model: flag(argv, '--model') ?? DEFAULT_SETUP_MODEL,
    port: Number(flag(argv, '--port') ?? DEFAULT_SETUP_PORT),
  }
  assertNotDefault(PROFILE_NAME)
  validateSetup(setup)

  const bin = hermesBin()
  if (!existsSync(bin)) {
    throw new Error(`Hermes CLI not found at ${bin} (set VT_HERMES_BIN)`)
  }
  const dir = profileDir()
  const run = async (args: string[]): Promise<string> => {
    console.log(`hermes ${args.join(' ')}`)
    return dryRun ? '' : hermes(bin, args)
  }

  // 1. Profile: create only when missing. `profile create` adds a directory; it changes nothing else.
  if (!existsSync(dir))
    await run(['profile', 'create', PROFILE_NAME, '--no-alias'])
  else console.log(`profile ${PROFILE_NAME}: exists`)

  // 2. Local model and manual approvals.
  for (const args of configCommands(setup)) await run(withProfile(args))

  // 3. Toolsets of the API server platform: computer_use, vision, file, terminal and nothing else.
  const listing = dryRun
    ? ''
    : await hermes(
        bin,
        withProfile(['tools', 'list', '--platform', API_PLATFORM]),
      )
  for (const args of toolsetCommands(listing)) await run(withProfile(args))

  // 4. API server env. The key is kept when present, generated otherwise, and never printed.
  const envPath = profileEnvPath()
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const existing = parseEnv(current)
  const values = profileEnvValues(setup, existing)
  const hadKey = Boolean(existing.API_SERVER_KEY?.trim())
  if (dryRun) {
    console.log(
      `.env: would set API_SERVER_ENABLED, API_SERVER_HOST, API_SERVER_PORT=${setup.port}, API_SERVER_KEY (${hadKey ? 'kept' : 'generated'})`,
    )
  } else {
    mkdirSync(dirname(envPath), { recursive: true })
    writeFileSync(envPath, upsertEnv(current, values), 'utf8')
    try {
      chmodSync(envPath, 0o600)
    } catch {
      // Windows: ACLs of the profile folder apply.
    }
    console.log(
      `.env: API server 127.0.0.1:${setup.port}, API_SERVER_KEY ${hadKey ? 'kept' : 'generated'} (not shown)`,
    )
  }

  console.log(
    [
      '',
      `profile: ${PROFILE_NAME} (${dir})`,
      `model: ${setup.model} @ ${setup.llmUrl}`,
      `url: http://127.0.0.1:${setup.port}`,
      `start: hermes -p ${PROFILE_NAME} gateway run   (the VoiceTalk shell does this when the agent is enabled)`,
    ].join('\n'),
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
