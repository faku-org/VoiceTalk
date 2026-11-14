import { gql } from '@/app/coreClient'
import type { SessionStatus } from './format'

export interface SessionSummaryRow {
  id: string
  title: string | null
  startedAt: number
  endedAt: number | null
  location: string
  status: SessionStatus
  utteranceCount: number
}

export interface SessionDetailData extends SessionSummaryRow {
  utterances: Array<{
    id: string
    speaker: 'user' | 'agent'
    text: string
    tStart: number
  }>
  summary: {
    summary: string
    openQuestions: string[]
    raised: string[]
  } | null
  externalNotes: Array<{
    id: number
    body: string
    createdAt: number
    location: string
    speakers: string[]
  }>
}

const ROW = 'id title startedAt endedAt location status utteranceCount'

export async function fetchSessions(): Promise<SessionSummaryRow[]> {
  const data = await gql<{ sessions: SessionSummaryRow[] }>(
    `{ sessions(limit: 100) { ${ROW} } }`,
  )
  return data.sessions
}

export async function fetchSession(
  id: string,
): Promise<SessionDetailData | null> {
  const data = await gql<{ session: SessionDetailData | null }>(
    `query ($id: String!) { session(id: $id) { ${ROW}
      utterances { id speaker text tStart }
      summary { summary openQuestions raised }
      externalNotes { id body createdAt location speakers } } }`,
    { id },
  )
  return data.session
}
