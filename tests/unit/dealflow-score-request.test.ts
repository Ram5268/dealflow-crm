import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_DEALFLOW_APP_BASE,
  SCORE_TIMEOUT_MS,
  dealflowAppBase,
  newScoreToken,
  parseScoreResponse,
  requestDealflowScores,
  type ScoreResponse,
} from '@/lib/core-data/dealflow-score/request'
import { dealflowDeepLink } from '@/lib/core-data/dealflow-sync/sync'

// Brief 45 PR F — the CRM's side of POST /api/crm/score-import (CONTRACT §7):
// a fresh one-time token per chunk (only its SHA-256 is ever stored), the
// exact request DealFlow's PR E route accepts, and every way the call can go
// wrong sorted into plain categories. Pure: fetch is a stub, nothing leaves
// this process.

const IMPORT = 'cimport0000000000000000001'
const ok: ScoreResponse = {
  importId: IMPORT,
  generatedAt: '2026-10-18T19:00:00.000Z',
  includeTestBuyers: false,
  ms: 12_000,
  scored: [
    {
      crmLeadId: 'lead_a', mojoId: 'mojo_a', priorityScore: 81.6, queueReason: 'Match: matchFitLift', primaryMatchId: 'm_a',
      primaryMatchFit: 88.4, primaryCaptureStatus: 'EXTERNAL_BOTH', primaryMatchConfidence: 'HIGH', matchReason: 'neighborhood + price',
      contributions: { matchFitLift: 30 }, buyers: [], notRankedReason: null,
    },
  ],
  skipped: [{ crmLeadId: 'lead_b', reason: 'no_mojo_id' }],
}

type Call = { url: string; init: RequestInit }
function stubFetch(answer: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = []
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return answer(call)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const args = (over: Partial<Parameters<typeof requestDealflowScores>[0]> = {}) => ({
  baseUrl: 'http://dealflow.test',
  importId: IMPORT,
  token: newScoreToken().token,
  leadIds: ['lead_a', 'lead_b'],
  ...over,
})

describe('the one-time token [CONTRACT §7; engineering precaution: no shared secret]', () => {
  it('is 32 random bytes in base64url (43 characters), fresh every time, and only its SHA-256 hex is kept', () => {
    const a = newScoreToken()
    const b = newScoreToken()
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(createHash('sha256').update(a.token, 'utf8').digest('hex'))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hash).not.toContain(a.token)
  })
})

describe("DealFlow's address [no new setting]", () => {
  it('reads DEALFLOW_APP_BASE_URL, with the same default as the morning sync', () => {
    expect(dealflowAppBase({ DEALFLOW_APP_BASE_URL: 'http://localhost:3150/', NODE_ENV: 'development' })).toBe('http://localhost:3150')
    expect(dealflowAppBase({ NODE_ENV: 'production' })).toBe(DEFAULT_DEALFLOW_APP_BASE)
    // The sync's deep links are built on the same default (sync.ts).
    expect(dealflowDeepLink('m_1')).toBe(`${DEFAULT_DEALFLOW_APP_BASE}/matches?m=m_1`)
  })

  it('outside a production build, an unset address never falls back to the live DealFlow [engineering precaution]', () => {
    expect(dealflowAppBase({ NODE_ENV: 'development' })).toBeNull()
    expect(dealflowAppBase({ NODE_ENV: 'test' })).toBeNull()
    expect(dealflowAppBase({})).toBeNull()
  })
})

describe('the request [CONTRACT §7 / PR E route]', () => {
  it('POSTs exactly { importId, token, leadIds } as JSON to /api/crm/score-import', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(200, ok))
    const a = args()
    const out = await requestDealflowScores(a, { fetch })
    expect(out).toEqual({ ok: true, response: ok })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://dealflow.test/api/crm/score-import')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ importId: IMPORT, token: a.token, leadIds: ['lead_a', 'lead_b'] })
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('waits up to 280 seconds by default', () => {
    expect(SCORE_TIMEOUT_MS).toBe(280_000)
  })

  it('DealFlow unreachable (refused connection, DNS): unreachable', async () => {
    const { fetch } = stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    expect(await requestDealflowScores(args(), { fetch })).toEqual({ ok: false, failure: 'unreachable', status: null, code: null })
  })

  it('a 500 (scoring_failed): server', async () => {
    const { fetch } = stubFetch(() => jsonResponse(500, { error: 'scoring_failed' }))
    expect(await requestDealflowScores(args(), { fetch })).toEqual({ ok: false, failure: 'server', status: 500, code: 'scoring_failed' })
  })

  it('a refusal (400 / 403 / 404) keeps its code', async () => {
    for (const [status, code] of [[400, 'invalid_request'], [403, 'bad_token'], [403, 'expired'], [404, 'not_found']] as const) {
      const { fetch } = stubFetch(() => jsonResponse(status, { error: code }))
      expect(await requestDealflowScores(args(), { fetch })).toEqual({ ok: false, failure: 'refused', status, code })
    }
  })

  it('any other non-200 (a login page, a redirect) is a refusal too, never a success', async () => {
    const { fetch } = stubFetch(() => new Response('<html>Log in</html>', { status: 401 }))
    expect(await requestDealflowScores(args(), { fetch })).toEqual({ ok: false, failure: 'refused', status: 401, code: null })
  })

  it('malformed JSON, or JSON of the wrong shape: unreadable', async () => {
    for (const body of ['{"scored": [', 'null', JSON.stringify({ ...ok, scored: 'nope' }), JSON.stringify({ ...ok, importId: 'another' })]) {
      const { fetch } = stubFetch(() => new Response(body, { status: 200 }))
      expect(await requestDealflowScores(args(), { fetch })).toEqual({ ok: false, failure: 'unreadable', status: 200, code: null })
    }
  })

  it('no answer in time: timeout (the request is aborted)', async () => {
    let aborted = false
    const { fetch } = stubFetch(({ init }) => {
      init.signal?.addEventListener('abort', () => (aborted = true))
      return new Promise<Response>(() => {}) // never answers, even when aborted
    })
    expect(await requestDealflowScores(args(), { fetch, timeoutMs: 30 })).toEqual({ ok: false, failure: 'timeout', status: null, code: null })
    expect(aborted).toBe(true)
  })
})

describe('reading the answer', () => {
  it("keeps DealFlow's fields and ignores extra keys", () => {
    const parsed = parseScoreResponse({ ...ok, extra: 1, scored: [{ ...ok.scored[0], extra: 2 }] }, IMPORT)
    expect(parsed).toEqual(ok)
  })

  it('refuses an answer for another import, or a scored lead without a Mojo ID', () => {
    expect(parseScoreResponse({ ...ok, importId: 'other' }, IMPORT)).toBeNull()
    expect(parseScoreResponse({ ...ok, scored: [{ ...ok.scored[0], mojoId: '' }] }, IMPORT)).toBeNull()
    expect(parseScoreResponse({ ...ok, skipped: [{ crmLeadId: 1 }] }, IMPORT)).toBeNull()
  })
})

describe('the two traps [brief §5.8]: the scoring path never runs the morning drop/clear', () => {
  it("no file of src/lib/core-data/dealflow-score names the morning sync's whole-batch statements", () => {
    const dir = path.join(process.cwd(), 'src/lib/core-data/dealflow-score')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), 'utf8')
      for (const banned of ['CLEAR_STALE_LEADS_SQL', 'REMOVE_STALE_SIGNALS_SQL', 'applySync', 'syncStatements', 'CallQueueEntry']) {
        expect(src, `${f} must not use ${banned}`).not.toContain(banned)
      }
    }
  })
})
