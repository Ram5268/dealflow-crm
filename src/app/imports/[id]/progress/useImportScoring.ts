'use client'

import { useEffect, useRef, useState } from 'react'
import { SCORE_ERROR } from '@/lib/core-data/dealflow-score/messages'
import type { LiveScoring } from '@/lib/core-data/importer/summary-view'

// Brief 45 PR F (CONTRACT §7): the progress page drives the ranking of an
// upload's new people. Once the import has completed, it calls
// POST /api/imports/:id/score again and again, one chunk (≤ 500 people) per
// call, passing the cursor along, until the CRM says done (or why it
// stopped). One run per import per tab, shared by every mount (development
// mounts twice); a reload starts a fresh run, which skips people already
// scored. Nothing here contacts anyone.
//
// Brief 50 PR 7 (open item 6.12): people ranked while DealFlow's 5:00 am run
// may have been going are ranked once more after it has certainly ended
// (src/lib/core-data/dealflow-score/nightly.ts). The CRM's last answer then
// says when to ask again (waitMs); the page keeps asking "is it due?" once a
// minute at most, and when the CRM says yes it drives that second ranking
// like the first. This keeps going while Ryan moves to other CRM pages in the
// same tab, and a later visit to this page asks again, so a closed page only
// matters if it stays closed past the hour DealFlow allows. It ends quietly
// whatever happens: everyone keeps their first ranking.

interface ChunkResult {
  done: boolean
  next: string | null
  scored: number
  skipped: { noMojoId: number; notCopied: number; other: number }
  retry?: true
  error?: string
  waitMs?: number
}

interface Run {
  state: LiveScoring
  listeners: Set<(s: LiveScoring) => void>
  settled: Promise<void>
}

interface FollowUp {
  done: Promise<void>
  /** Asked for again while running: run once more after, waiting this long first. */
  again?: number
}

const runs = new Map<string, Run>()
const followUps = new Map<string, FollowUp>()
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// The CRM itself didn't answer: try a little longer, then show the fallback.
const MAX_MISSES = 3
/** Brief 50 PR 7: while waiting for the second ranking, ask again at least once a minute. */
export const MAX_WAIT_STEP_MS = 60_000
// A minute at a time, for at most DealFlow's hour for an upload.
const MAX_WAIT_STEPS = 70

export interface DriveDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** People sent so far (scored or skipped): the first ranking's "N of M done". */
  onProcessed?: (n: number) => void
}

export interface DriveOutcome {
  /** Why the first ranking stopped short (the page shows it); never set for the second. */
  failed: string | null
  /** The CRM said to ask about the second ranking after this many milliseconds. */
  followUpInMs?: number
  /** 'second' only: the CRM started the second ranking. */
  ranAgain?: true
}

/**
 * One ranking pass, chunk after chunk until the CRM says done. 'first': the
 * upload's first ranking. 'second' (Brief 50 PR 7): starts by asking whether
 * the second ranking is due; when the CRM starts it, goes on to its end.
 */
export async function driveScoring(importId: string, deps: DriveDeps = {}, mode: 'first' | 'second' = 'first'): Promise<DriveOutcome> {
  const fetchImpl = deps.fetch ?? fetch
  const sleep = deps.sleep ?? realSleep
  let after: string | null = null
  let ask = mode === 'second'
  let processed = 0
  let misses = 0
  let ranAgain = false
  // 1,000 chunks of 500 is far beyond any upload.
  for (let i = 0; i < 1_000; i++) {
    const body: { retry?: true; after?: string } = ask ? { retry: true } : after ? { after } : {}
    const res: Response | null = await fetchImpl(`/api/imports/${encodeURIComponent(importId)}/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null)
    const r: ChunkResult | null = res?.ok ? ((await res.json().catch(() => null)) as ChunkResult | null) : null
    if (!r) {
      if (++misses >= MAX_MISSES) return { failed: mode === 'first' ? SCORE_ERROR.unreachable : null }
      await sleep(2_000 * misses)
      continue
    }
    misses = 0
    const sent = r.scored + r.skipped.noMojoId + r.skipped.notCopied + r.skipped.other
    if (mode === 'first') {
      processed += sent
      deps.onProcessed?.(processed)
    } else if (sent > 0 || !ask) ranAgain = true
    // Another tab (or the page before a reload) has a chunk out: wait, then go on.
    if (r.retry) {
      await sleep(2_000 + Math.random() * 2_000)
      continue
    }
    if (r.done) {
      const out: DriveOutcome = { failed: null }
      if (r.waitMs !== undefined && !r.error) out.followUpInMs = r.waitMs
      if (ranAgain) out.ranAgain = true
      return out
    }
    ask = false
    after = r.next
  }
  return { failed: null }
}

/**
 * Brief 50 PR 7: waits for the second ranking (asking at most a minute
 * apart, so the CRM's clock decides, not this browser's) and drives it.
 */
export async function followUpScoring(importId: string, deps: DriveDeps = {}, firstWaitMs: number): Promise<boolean> {
  const sleep = deps.sleep ?? realSleep
  let wait = firstWaitMs
  for (let step = 0; step < MAX_WAIT_STEPS; step++) {
    if (wait > 0) await sleep(Math.min(wait, MAX_WAIT_STEP_MS))
    const out = await driveScoring(importId, { fetch: deps.fetch, sleep }, 'second')
    if (out.ranAgain) return true
    if (out.followUpInMs === undefined) return false
    wait = out.followUpInMs
  }
  return false
}

// One follow-up per import per tab; it outlives the page (other CRM pages in
// this tab). Asked for again while one runs (the first ranking just ended
// while the page's opening question was out), it runs once more after.
function ensureFollowUp(importId: string, firstWaitMs: number, onRanked: () => void): void {
  const current = followUps.get(importId)
  if (current) {
    current.again = Math.max(current.again ?? 0, firstWaitMs)
    return
  }
  const entry: FollowUp = {
    done: followUpScoring(importId, {}, firstWaitMs)
      .catch(() => false)
      .then((ranked) => {
        followUps.delete(importId)
        if (ranked) onRanked()
        if (entry.again !== undefined) ensureFollowUp(importId, entry.again, onRanked)
      }),
  }
  followUps.set(importId, entry)
}

function start(importId: string, onFollowUpDone: () => void): Run {
  const run: Run = { state: { running: true, processed: 0, failed: null }, listeners: new Set(), settled: Promise.resolve() }
  const update = (patch: Partial<LiveScoring>) => {
    run.state = { ...run.state, ...patch }
    for (const l of run.listeners) l(run.state)
  }
  run.settled = (async () => {
    const out = await driveScoring(importId, { onProcessed: (processed) => update({ processed }) }, 'first')
    update({ running: false, failed: out.failed })
    if (out.followUpInMs !== undefined) ensureFollowUp(importId, out.followUpInMs, onFollowUpDone)
  })().finally(() => runs.delete(importId))
  return run
}

/**
 * Drives the scoring while `active` (the import completed and its new people
 * still need ranking); calls onSettled once the run ends, so the page reads
 * the final state back from the server. Brief 50 PR 7: also asks once, on
 * opening the page, whether a second ranking is owed (and drives it).
 */
export function useImportScoring(importId: string, active: boolean, onSettled: () => void): LiveScoring {
  const [live, setLive] = useState<LiveScoring>({ running: false, processed: 0, failed: null })
  const settledRef = useRef(onSettled)
  useEffect(() => {
    settledRef.current = onSettled
  })
  // Brief 50 PR 7: a later visit picks up a second ranking still owed. While
  // the first ranking is still going, the CRM answers "nothing owed".
  useEffect(() => {
    ensureFollowUp(importId, 0, () => settledRef.current())
  }, [importId])
  useEffect(() => {
    if (!active) return
    let run = runs.get(importId)
    if (!run) {
      run = start(importId, () => settledRef.current())
      runs.set(importId, run)
    }
    const current = run
    let alive = true
    const listener = (s: LiveScoring) => setLive(s)
    current.listeners.add(listener)
    setLive(current.state)
    void current.settled.then(() => {
      if (alive) settledRef.current()
    })
    return () => {
      alive = false
      current.listeners.delete(listener)
    }
  }, [importId, active])
  return live
}
