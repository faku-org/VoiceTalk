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
  /** 'call' for a VoiceTalk call, or the platform key of a captured one. */
  source: string
}

export interface SessionDetailData extends SessionSummaryRow {
  utterances: Array<{
    id: string
    speaker: 'user' | 'agent' | 'remote'
    label: string | null
    speakerName?: string | null
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

const ROW = 'id title startedAt endedAt location status utteranceCount source'

/** `source` keeps one session source ('journal'); without it the list is everything. */
export async function fetchSessions(
  source?: string,
): Promise<SessionSummaryRow[]> {
  const data = await gql<{ sessions: SessionSummaryRow[] }>(
    `query($source: String) { sessions(limit: 100, source: $source) { ${ROW} } }`,
    { source: source ?? null },
  )
  return data.sessions
}

export async function fetchSession(
  id: string,
): Promise<SessionDetailData | null> {
  const data = await gql<{ session: SessionDetailData | null }>(
    `query ($id: String!) { session(id: $id) { ${ROW}
      utterances { id speaker label speakerName text tStart }
      summary { summary openQuestions raised }
      externalNotes { id body createdAt location speakers } } }`,
    { id },
  )
  return data.session
}
