import { describe, it, expect } from 'vitest'
import {
  DEALFLOW_NIGHTLY_MAX_RUN_MS,
  DEALFLOW_NIGHTLY_UTC_HOUR,
  NIGHTLY_CLOCK_MARGIN_MS,
  NIGHTLY_RISK_FROM_UTC,
  NIGHTLY_RISK_UNTIL_UTC,
  nightlySafeAfter,
  rankedDuringNightly,
} from '@/lib/core-data/dealflow-score/nightly'
import { MAX_WAIT_STEP_MS, driveScoring, followUpScoring } from '@/app/imports/[id]/progress/useImportScoring'

// Brief 50 PR 7 (open item 6.12): people uploaded while DealFlow's 5:00 am
// run is going are ranked once more after it ends. The CRM can't ask DealFlow
// whether its run is going, so it uses the run's clock: DealFlow's cron
// starts it at some minute of 09:00–09:59 UTC (Vercel's Hobby plan picks the
// minute), and Vercel stops it after 300 seconds. Pure: no database.

const utc = (hhmmss: string, day = '2026-10-20') => new Date(`${day}T${hhmmss}Z`)

describe("DealFlow's nightly hour, as the CRM sees it", () => {
  it("comes from DealFlow's own settings, with a margin for clocks", () => {
    expect(DEALFLOW_NIGHTLY_UTC_HOUR).toBe(9) // DealFlow vercel.json: "0 9 * * *"
    expect(DEALFLOW_NIGHTLY_MAX_RUN_MS).toBe(300_000) // its maxDuration
    expect(NIGHTLY_CLOCK_MARGIN_MS).toBe(120_000)
    expect(NIGHTLY_RISK_FROM_UTC).toBe('08:58:00')
    expect(NIGHTLY_RISK_UNTIL_UTC).toBe('10:07:00')
  })

  it('a ranking from 08:58 up to (not including) 10:07 UTC may have overlapped the run, any day', () => {
    expect(rankedDuringNightly(utc('08:57:59.999'))).toBe(false)
    expect(rankedDuringNightly(utc('08:58:00'))).toBe(true)
    expect(rankedDuringNightly(utc('09:17:30'))).toBe(true)
    expect(rankedDuringNightly(utc('10:06:59.999'))).toBe(true)
    expect(rankedDuringNightly(utc('10:07:00'))).toBe(false)
    expect(rankedDuringNightly(utc('14:10:00'))).toBe(false)
    expect(rankedDuringNightly(utc('09:30:00', '2027-01-15'))).toBe(true) // winter: still 09:00 UTC (4:00 am EST)
  })

  it('every run that could have missed an upload has ended 7 minutes after the upload finished', () => {
    // A run that missed them started before the upload finished, and Vercel
    // stops a run after 5 minutes; 2 more minutes for clocks.
    expect(nightlySafeAfter(utc('09:10:00')).toISOString()).toBe('2026-10-20T09:17:00.000Z')
  })
})

// The import page's loop (useImportScoring) against a stand-in CRM.
function fakeCrm(answers: Record<string, unknown>[]) {
  const bodies: Record<string, unknown>[] = []
  const sleeps: number[] = []
  let i = 0
  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const answer = answers[i++]
    if (!answer) throw new Error('asked once too often')
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  return { fetch, sleep, bodies, sleeps }
}
const chunk = (over: Record<string, unknown>) => ({ done: false, next: null, scored: 0, notRanked: 0, skipped: { noMojoId: 0, notCopied: 0, other: 0 }, remaining: 0, ...over })

describe('the import page: the first ranking, then the second one when the CRM says it is due', () => {
  it('the first ranking ends as before; the CRM’s "ask again in N ms" is passed on, not waited for here', async () => {
    const crm = fakeCrm([
      chunk({ next: 'lead_b', scored: 2, remaining: 1 }),
      chunk({ done: true, scored: 1, skipped: { noMojoId: 1, notCopied: 0, other: 0 }, waitMs: 150_000 }),
    ])
    const processed: number[] = []
    const out = await driveScoring('imp_1', { fetch: crm.fetch, sleep: crm.sleep, onProcessed: (n) => processed.push(n) }, 'first')
    expect(out).toEqual({ failed: null, followUpInMs: 150_000 })
    expect(crm.bodies).toEqual([{}, { after: 'lead_b' }])
    expect(crm.sleeps).toEqual([])
    expect(processed.at(-1)).toBe(4)
  })

  it('an upload outside the run: one ranking, nothing to follow up', async () => {
    const crm = fakeCrm([chunk({ next: 'lead_b', scored: 2, remaining: 1 }), chunk({ done: true, scored: 1 })])
    expect(await driveScoring('imp_2', { fetch: crm.fetch, sleep: crm.sleep }, 'first')).toEqual({ failed: null })
    expect(crm.bodies).toEqual([{}, { after: 'lead_b' }])
  })

  it('the follow-up waits in steps of at most a minute, asking only "is it due?", then drives the second ranking to the end', async () => {
    const crm = fakeCrm([
      chunk({ done: true, waitMs: 90_000 }),
      chunk({ done: true, waitMs: 30_000 }),
      chunk({ next: 'lead_b', scored: 2, remaining: 1 }), // the CRM reopened the upload and sent the first chunk
      chunk({ done: true, scored: 2 }),
    ])
    const processed: number[] = []
    await followUpScoring('imp_3', { fetch: crm.fetch, sleep: crm.sleep, onProcessed: (n) => processed.push(n) }, 150_000)
    expect(MAX_WAIT_STEP_MS).toBe(60_000)
    expect(crm.sleeps).toEqual([60_000, 60_000, 30_000])
    expect(crm.bodies).toEqual([{ retry: true }, { retry: true }, { retry: true }, { after: 'lead_b' }])
    // The second ranking re-ranks people already counted: the page's "N of M done" isn't moved.
    expect(processed).toEqual([])
  })

  it('a later visit asks once; with nothing owed, that is all', async () => {
    const crm = fakeCrm([chunk({ done: true })])
    await followUpScoring('imp_4', { fetch: crm.fetch, sleep: crm.sleep }, 0)
    expect(crm.bodies).toEqual([{ retry: true }])
    expect(crm.sleeps).toEqual([])
  })

  it("if the CRM can't be reached during the follow-up, it stops quietly (the people keep their first ranking)", async () => {
    const sleeps: number[] = []
    let calls = 0
    const fetch = (async () => {
      calls++
      throw new Error('offline')
    }) as typeof globalThis.fetch
    expect(await driveScoring('imp_5', { fetch, sleep: async (ms) => void sleeps.push(ms) }, 'second')).toEqual({ failed: null })
    expect(calls).toBe(3)
  })
})
