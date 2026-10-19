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

interface ChunkResult {
  done: boolean
  next: string | null
  scored: number
  skipped: { noMojoId: number; notCopied: number; other: number }
  retry?: true
  error?: string
}

interface Run {
  state: LiveScoring
  listeners: Set<(s: LiveScoring) => void>
  settled: Promise<void>
}

const runs = new Map<string, Run>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// The CRM itself didn't answer: try a little longer, then show the fallback.
const MAX_MISSES = 3

function start(importId: string): Run {
  const run: Run = { state: { running: true, processed: 0, failed: null }, listeners: new Set(), settled: Promise.resolve() }
  const update = (patch: Partial<LiveScoring>) => {
    run.state = { ...run.state, ...patch }
    for (const l of run.listeners) l(run.state)
  }
  run.settled = (async () => {
    let after: string | null = null
    let misses = 0
    // 1,000 chunks of 500 is far beyond any upload.
    for (let i = 0; i < 1_000; i++) {
      const res: Response | null = await fetch(`/api/imports/${encodeURIComponent(importId)}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(after ? { after } : {}),
      }).catch(() => null)
      const r: ChunkResult | null = res?.ok ? ((await res.json().catch(() => null)) as ChunkResult | null) : null
      if (!r) {
        if (++misses >= MAX_MISSES) {
          update({ running: false, failed: SCORE_ERROR.unreachable })
          return
        }
        await sleep(2_000 * misses)
        continue
      }
      misses = 0
      update({ processed: run.state.processed + r.scored + r.skipped.noMojoId + r.skipped.notCopied + r.skipped.other })
      // Another tab (or the page before a reload) has a chunk out: wait, then go on.
      if (r.retry) {
        await sleep(2_000 + Math.random() * 2_000)
        continue
      }
      if (r.done) break
      after = r.next
    }
    update({ running: false })
  })().finally(() => runs.delete(importId))
  return run
}

/**
 * Drives the scoring while `active` (the import completed and its new people
 * still need ranking); calls onSettled once the run ends, so the page reads
 * the final state back from the server.
 */
export function useImportScoring(importId: string, active: boolean, onSettled: () => void): LiveScoring {
  const [live, setLive] = useState<LiveScoring>({ running: false, processed: 0, failed: null })
  const settledRef = useRef(onSettled)
  useEffect(() => {
    settledRef.current = onSettled
  })
  useEffect(() => {
    if (!active) return
    let run = runs.get(importId)
    if (!run) {
      run = start(importId)
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
