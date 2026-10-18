// Brief 45 (PR F): the CRM's side of DealFlow's POST /api/crm/score-import
// (DealFlow PR E; CONTRACT §7). When an upload finishes, the CRM sends the
// upload's new leads to DealFlow, at most 500 per request, so they are ranked
// within minutes instead of the next morning [Ryan, 2026-10-18: "no list ever
// sits unranked"].
//
// The key is a one-time token: 32 random bytes, made fresh for every request.
// The CRM stores only its SHA-256 on the ImportBatch row; DealFlow reads that
// hash through its read-only link to the CRM and compares. There is no shared
// secret and no new setting [engineering precaution]. Nothing here contacts a
// homeowner: DealFlow only reads, scores and answers.
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** The same default as the morning sync's deep links (dealflow-sync/sync.ts). */
export const DEFAULT_DEALFLOW_APP_BASE = 'https://dealflow-inbox-intelligence.vercel.app'
export const SCORE_IMPORT_PATH = '/api/crm/score-import'
/** DealFlow's route may run 300 s (maxDuration); a 500-lead chunk took 11–22 s on the Railway test database. */
export const SCORE_TIMEOUT_MS = 280_000

/**
 * DealFlow's address: DEALFLOW_APP_BASE_URL, else the morning sync's default.
 * Outside a production build an unset address gives null (don't call), so a
 * local or test run never reaches the live DealFlow by accident
 * [engineering precaution].
 */
export function dealflowAppBase(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.DEALFLOW_APP_BASE_URL?.trim()
  if (set) return set.replace(/\/+$/, '')
  return env.NODE_ENV === 'production' ? DEFAULT_DEALFLOW_APP_BASE : null
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** A fresh token (43 base64url characters) and the SHA-256 hex the CRM stores instead of it. */
export function newScoreToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: sha256Hex(token) }
}

// DealFlow's 200 answer (PR E lib/importScoring/signals.ts ScoredLead). Extra
// keys are dropped; anything missing or of the wrong type makes the whole
// answer unreadable, so a half-understood answer is never written.
const scoredLeadSchema = z.object({
  crmLeadId: z.string().min(1),
  mojoId: z.string().min(1),
  priorityScore: z.number().nullable(),
  queueReason: z.string().nullable(),
  primaryMatchId: z.string().nullable(),
  primaryMatchFit: z.number().nullable(),
  primaryCaptureStatus: z.string().nullable(),
  primaryMatchConfidence: z.string().nullable(),
  matchReason: z.string().nullable(),
  contributions: z.record(z.string(), z.unknown()).nullable(),
  // Whitelisted again (toBuyers) before anything is stored.
  buyers: z.array(z.unknown()),
  // null: ranked; else the hard filter that left it off the call list (e.g. 'no_matches').
  notRankedReason: z.string().nullable(),
})

const scoreResponseSchema = z.object({
  importId: z.string(),
  generatedAt: z.string(),
  includeTestBuyers: z.boolean(),
  ms: z.number().optional(),
  scored: z.array(scoredLeadSchema),
  // reason: 'no_mojo_id' | 'not_copied' | 'not_new_in_import'
  skipped: z.array(z.object({ crmLeadId: z.string(), reason: z.string() })),
})

export type ScoredLead = z.infer<typeof scoredLeadSchema>
export type ScoreResponse = z.infer<typeof scoreResponseSchema>

/** DealFlow's answer, or null when it isn't one (or is about another import). */
export function parseScoreResponse(raw: unknown, importId: string): ScoreResponse | null {
  const parsed = scoreResponseSchema.safeParse(raw)
  return parsed.success && parsed.data.importId === importId ? parsed.data : null
}

/**
 * unreachable: no connection (refused, DNS, network); timeout: no answer in
 * time; server: a 5xx; unreadable: a 200 that isn't DealFlow's answer;
 * refused: any other status (DealFlow's 400 / 403 / 404, a login page, a
 * redirect). Every one of them means "ranked in tomorrow morning's update".
 */
export type DealflowFailure = 'unreachable' | 'timeout' | 'server' | 'unreadable' | 'refused'

export type DealflowOutcome =
  | { ok: true; response: ScoreResponse }
  | { ok: false; failure: DealflowFailure; status: number | null; code: string | null }

export interface ScoreRequest {
  baseUrl: string
  importId: string
  token: string
  leadIds: string[]
}

export interface RequestDeps {
  fetch?: typeof fetch
  timeoutMs?: number
}

const fail = (failure: DealflowFailure, status: number | null = null, code: string | null = null): DealflowOutcome => ({
  ok: false,
  failure,
  status,
  code,
})

// DealFlow's refusal code ({ error: 'bad_token' }), for the log and the message.
function errorCode(body: unknown): string | null {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return typeof e === 'string' ? e.slice(0, 40) : null
}

/** One request to DealFlow. Never throws; the token is sent and never logged. */
export async function requestDealflowScores(req: ScoreRequest, deps: RequestDeps = {}): Promise<DealflowOutcome> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Ends the wait even if the fetch ignores its abort signal.
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, deps.timeoutMs ?? SCORE_TIMEOUT_MS)
  })
  const attempt = (async (): Promise<DealflowOutcome> => {
    let res: Response
    let text: string
    try {
      res = await fetchImpl(`${req.baseUrl}${SCORE_IMPORT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId: req.importId, token: req.token, leadIds: req.leadIds }),
        signal: controller.signal,
      })
      text = await res.text()
    } catch {
      return fail(controller.signal.aborted ? 'timeout' : 'unreachable')
    }
    let body: unknown
    let readable = true
    try {
      body = JSON.parse(text)
    } catch {
      readable = false
    }
    if (res.status === 200) {
      const parsed = readable ? parseScoreResponse(body, req.importId) : null
      return parsed ? { ok: true, response: parsed } : fail('unreadable', 200)
    }
    return fail(res.status >= 500 ? 'server' : 'refused', res.status, readable ? errorCode(body) : null)
  })()
  try {
    const first = await Promise.race([attempt, timedOut])
    return first === 'timeout' ? fail('timeout') : first
  } finally {
    clearTimeout(timer)
  }
}
