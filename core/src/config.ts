export interface CoreConfig {
  port: number
  cartesiaApiKey: string | undefined
}

const DEFAULT_PORT = 4310

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): CoreConfig {
  const rawPort = env.VT_CORE_PORT?.trim()
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`VT_CORE_PORT invalid: ${rawPort}`)
  }
  const key = env.CARTESIA_API_KEY?.trim()
  return { port, cartesiaApiKey: key ? key : undefined }
}
