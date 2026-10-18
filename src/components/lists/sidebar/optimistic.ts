// Brief 45 — the sidebar's optimistic moves, as a pure state machine (so the
// rules are unit-tested; SidebarLists only wires it up).
//
// A move shows at once (its planned sidebar), its API calls go one after
// another, and then:
//  - every call saved: once the LAST move in flight is answered, the sidebar
//    asks the shared store to reload and keeps showing the planned order until
//    that reload lands (no flicker back to the old order). Then it shows the
//    store again, so anything changed since (a new list, a rename, a count)
//    appears;
//  - a call refused (e.g. a duplicate name in the target folder): the planned
//    view is dropped at once, so the list snaps back, and the caller shows the
//    API's words in a toast. The store still reloads once the queue drains,
//    so the sidebar ends up exactly as the server has it.
import type { SidebarData } from '@/lib/core-data/lists/types'

export interface MovesState {
  /** What the sidebar shows while moves are saving; null = the store's own data. */
  override: SidebarData | null
  /** Moves planned and not yet answered. */
  inFlight: number
  /** Every move answered; showing the planned order until the store's reload lands. */
  awaitingReload: boolean
}

export const IDLE_MOVES: MovesState = { override: null, inFlight: 0, awaitingReload: false }

export type MovesEvent =
  /** A move was planned: show its sidebar now. */
  | { type: 'planned'; next: SidebarData }
  /** All of that move's calls succeeded. */
  | { type: 'saved' }
  /** One of its calls failed: put things back now. */
  | { type: 'failed' }
  /** The shared store finished a load (it isn't loading any more). */
  | { type: 'loaded' }

export interface MovesStep {
  state: MovesState
  /** Ask the store to reload now (notifyListsChanged). */
  reload: boolean
}

export function movesReducer(s: MovesState, e: MovesEvent): MovesStep {
  switch (e.type) {
    case 'planned':
      return { state: { override: e.next, inFlight: s.inFlight + 1, awaitingReload: false }, reload: false }
    case 'saved':
    case 'failed': {
      const inFlight = Math.max(0, s.inFlight - 1)
      const drained = inFlight === 0
      return {
        state: {
          // A refusal drops the planned view at once; a save keeps it until the reload lands.
          override: e.type === 'failed' ? null : s.override,
          inFlight,
          awaitingReload: drained || s.awaitingReload,
        },
        reload: drained,
      }
    }
    case 'loaded':
      // Only a load after the last answer clears the view, never one while a move is still saving.
      if (!s.awaitingReload || s.inFlight > 0) return { state: s, reload: false }
      return { state: IDLE_MOVES, reload: false }
  }
}

/** What to plan the next move on: the view on screen (a quick second move builds on the first). */
export const movesBase = (s: MovesState, storeData: SidebarData | null): SidebarData | null => s.override ?? storeData
