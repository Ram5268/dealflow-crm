import { describe, it, expect } from 'vitest'
import type { SidebarData } from '@/lib/core-data/lists/types'
import { IDLE_MOVES, movesBase, movesReducer, type MovesEvent, type MovesState } from '@/components/lists/sidebar/optimistic'

// Brief 45 PR B — the sidebar's optimistic moves (review should-fix: these had
// no automated test). A move shows at once; a saved move keeps showing until
// the store's reload lands and then hands back to the store (so later changes,
// like a newly made list, appear); a refused move snaps back at once; and the
// store reloads exactly once, after the last move in flight is answered.

const sidebar = (label: string): SidebarData => ({
  allLeads: { count: 0, rankedAt: null },
  folders: [],
  lists: [{ id: label, name: label, folderId: null, source: 'manual', sortOrder: 0, archivedAt: null, memberCount: 0, createdAt: '2026-10-18T12:00:00.000Z' }],
  archivedCount: 0,
  groups: [],
  workflows: [],
})
const A = sidebar('after move A')
const B = sidebar('after moves A and B')
const STORE = sidebar('the store')

/** Run events in order; return the final state and how many reloads were asked for. */
function run(events: MovesEvent[], from: MovesState = IDLE_MOVES): { state: MovesState; reloads: number; trace: MovesState[] } {
  let state = from
  let reloads = 0
  const trace: MovesState[] = []
  for (const e of events) {
    const step = movesReducer(state, e)
    state = step.state
    if (step.reload) reloads++
    trace.push(state)
  }
  return { state, reloads, trace }
}

describe('optimistic moves', () => {
  it('a move shows at once, before any answer', () => {
    const { state, reloads } = run([{ type: 'planned', next: A }])
    expect(state.override).toBe(A)
    expect(reloads).toBe(0)
    expect(movesBase(state, STORE)).toBe(A)
  })

  it('saved: keeps the moved order (no flicker), asks for one reload, then hands back to the store', () => {
    const saved = run([{ type: 'planned', next: A }, { type: 'saved' }])
    expect(saved.state.override).toBe(A)
    expect(saved.state.awaitingReload).toBe(true)
    expect(saved.reloads).toBe(1)
    const after = run([{ type: 'loaded' }], saved.state)
    // The view is cleared: the sidebar shows the store again, so a list made after the move appears.
    expect(after.state).toEqual(IDLE_MOVES)
    expect(movesBase(after.state, STORE)).toBe(STORE)
  })

  it('refused: snaps back at once, and the store still reloads once to match the server', () => {
    const { state, reloads } = run([{ type: 'planned', next: A }, { type: 'failed' }])
    expect(state.override).toBeNull()
    expect(movesBase(state, STORE)).toBe(STORE)
    expect(reloads).toBe(1)
    expect(run([{ type: 'loaded' }], state).state).toEqual(IDLE_MOVES)
  })

  it('a load that lands while a move is still saving changes nothing', () => {
    const { state } = run([{ type: 'planned', next: A }, { type: 'loaded' }])
    expect(state.override).toBe(A)
    expect(state.inFlight).toBe(1)
  })

  it('two quick moves: the second builds on the first; one reload, after the last answer', () => {
    const r = run([{ type: 'planned', next: A }, { type: 'planned', next: B }, { type: 'saved' }])
    expect(r.state.override).toBe(B)
    expect(r.reloads).toBe(0) // the second move is still saving
    const done = run([{ type: 'loaded' }, { type: 'saved' }, { type: 'loaded' }], r.state)
    expect(done.trace[0].override).toBe(B) // an early load doesn't clear it
    expect(done.reloads).toBe(1)
    expect(done.state).toEqual(IDLE_MOVES)
  })

  it('a move planned while the previous reload is pending waits for its own reload', () => {
    const r = run([{ type: 'planned', next: A }, { type: 'saved' }, { type: 'planned', next: B }, { type: 'loaded' }])
    expect(r.state.override).toBe(B) // the reload for A landed, but B is still saving
    const done = run([{ type: 'saved' }, { type: 'loaded' }], r.state)
    expect(done.reloads).toBe(1)
    expect(done.state).toEqual(IDLE_MOVES)
  })

  it('the first of two moves refused: snaps back at once; one reload after both answer', () => {
    const r = run([{ type: 'planned', next: A }, { type: 'planned', next: B }, { type: 'failed' }])
    expect(r.state.override).toBeNull()
    expect(r.reloads).toBe(0)
    const done = run([{ type: 'saved' }, { type: 'loaded' }], r.state)
    expect(done.reloads).toBe(1)
    expect(done.state).toEqual(IDLE_MOVES)
  })

  it('a load with nothing pending is a no-op', () => {
    expect(movesReducer(IDLE_MOVES, { type: 'loaded' })).toEqual({ state: IDLE_MOVES, reload: false })
  })
})
