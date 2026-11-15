export { HermesClient, toAgentEvent } from './client.ts'
export {
  AGENT_PROVIDERS,
  ALT_AGENT_MODEL,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PORT,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_URL,
  PROFILE_NAME,
  assertNotDefault,
  readAgentKey,
  readOpenRouterKey,
  type AgentProvider,
} from './profile.ts'
export {
  createAgentService,
  getAgentService,
  type AgentPort,
  type AgentRunHandle,
  type AgentStatus,
} from './service.ts'
export * from './types.ts'
