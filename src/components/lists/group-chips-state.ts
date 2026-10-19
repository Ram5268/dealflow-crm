// Brief 45 PR C — what each group chip on a lead's contact card shows while
// its change travels to the CRM [brief §5.3]. One click adds the lead to the
// group and the chip lights up at once; a second click removes it; if the CRM
// refuses, the chip goes back and the page says why (optimistic, rolled back
// with a toast). No menus and no save button.
//
// One request per chip at a time, so two quick clicks can never reach the CRM
// out of order; the chip always ends on the person's last click. The reducer
// is pure; GroupChipsController sends the requests through PR A's client.ts
// (PUT/DELETE /api/core-data/groups/<id>/members/<leadId>, and POST
// /api/core-data/groups for "+"), and PR A's API writes the timeline entries.
//
// A group is a label only: nothing here contacts anyone [Ryan, 2026-09-24].
import {
  ListsApiError,
  addLeadToGroup,
  createGroup,
  notifyListsChanged,
  removeLeadFromGroup,
} from '@/lib/core-data/lists/client'
import { nameProblem, normalizeName } from '@/lib/core-data/lists/rules'
import type { GroupDTO } from '@/lib/core-data/lists/types'

export interface ChipState {
  /** The groups the CRM has confirmed the lead is in. */
  confirmed: readonly string[]
  /** What the person last asked for, per group, until the CRM has it. */
  wanted: Readonly<Record<string, boolean>>
  /** The value on its way to the CRM for a group (one request per chip at a time). */
  sending: Readonly<Record<string, boolean>>
}

export type ChipAction =
  | { type: 'toggle'; groupId: string }
  | { type: 'send'; groupId: string; value: boolean }
  | { type: 'confirmed'; groupId: string; value: boolean }
  | { type: 'failed'; groupId: string; value: boolean }
  | { type: 'reset'; memberOf: readonly string[] }

const omit = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _gone, ...rest } = record
  return rest
}

export function initChipState(memberOf: readonly string[]): ChipState {
  return { confirmed: [...new Set(memberOf)], wanted: {}, sending: {} }
}

/** What the chip shows: the person's latest click, else what the CRM has. */
export function isOn(s: ChipState, groupId: string): boolean {
  return groupId in s.wanted ? s.wanted[groupId] : s.confirmed.includes(groupId)
}

// A wish the CRM already matches, with nothing on its way, is done.
function tidy(s: ChipState, groupId: string): ChipState {
  if (groupId in s.wanted && !(groupId in s.sending) && s.wanted[groupId] === s.confirmed.includes(groupId)) {
    return { ...s, wanted: omit(s.wanted, groupId) }
  }
  return s
}

const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id))

export function chipReducer(s: ChipState, a: ChipAction): ChipState {
  switch (a.type) {
    case 'toggle':
      return tidy({ ...s, wanted: { ...s.wanted, [a.groupId]: !isOn(s, a.groupId) } }, a.groupId)
    case 'send':
      return { ...s, sending: { ...s.sending, [a.groupId]: a.value } }
    case 'confirmed': {
      const has = s.confirmed.includes(a.groupId)
      const confirmed = a.value ? (has ? s.confirmed : [...s.confirmed, a.groupId]) : s.confirmed.filter((id) => id !== a.groupId)
      return tidy({ ...s, confirmed, sending: omit(s.sending, a.groupId) }, a.groupId)
    }
    case 'failed':
      // Back to what the CRM has, whatever was clicked meanwhile.
      return { ...s, sending: omit(s.sending, a.groupId), wanted: omit(s.wanted, a.groupId) }
    case 'reset': {
      // New rows from the page. A click still on its way keeps showing.
      const memberOf = [...new Set(a.memberOf)]
      if (sameMembers(memberOf, s.confirmed)) return s
      let next: ChipState = { ...s, confirmed: memberOf }
      for (const id of Object.keys(next.wanted)) next = tidy(next, id)
      return next
    }
  }
}

/** The requests to start now: a wish that differs from the CRM, for a chip with nothing in flight. */
export function nextSends(s: ChipState): { groupId: string; value: boolean }[] {
  return Object.entries(s.wanted)
    .filter(([id, value]) => !(id in s.sending) && value !== s.confirmed.includes(id))
    .map(([groupId, value]) => ({ groupId, value }))
}

/** Nothing asked for and nothing on its way. */
export function isSettled(s: ChipState): boolean {
  return Object.keys(s.wanted).length === 0 && Object.keys(s.sending).length === 0
}

/** The lit chips in `order` (sidebar order), then any other lit group (e.g. one just made with "+"). */
export function litGroupIds(s: ChipState, order: readonly string[]): string[] {
  const lit = order.filter((id) => isOn(s, id))
  const others = [...new Set([...s.confirmed, ...Object.keys(s.wanted)])].filter((id) => !order.includes(id) && isOn(s, id))
  return [...lit, ...others]
}

// ─── The requests ────────────────────────────────────────────────────────────

export interface ChipApi {
  add(groupId: string, leadId: string): Promise<unknown>
  remove(groupId: string, leadId: string): Promise<unknown>
  create(input: { name: string; leadId: string }): Promise<{ group: GroupDTO; added: number }>
}

/** PR A's routes, through client.ts. */
export const CRM_CHIP_API: ChipApi = {
  add: (groupId, leadId) => addLeadToGroup(groupId, leadId),
  remove: (groupId, leadId) => removeLeadFromGroup(groupId, leadId),
  create: (input) => createGroup(input),
}

export const OFFLINE_MESSAGE = "Couldn't reach the CRM. Check your connection and try again."
export const SAVE_FAILED_MESSAGE = "The CRM couldn't save that just now. Please try again."
export const LOAD_FAILED_MESSAGE = "The CRM couldn't load that just now. Please try again."

/**
 * What to tell the person: the API's own plain-English message; a plain
 * sentence for a server error (5xx), whose text isn't written for people; or
 * the offline one when fetch itself failed. `action` picks the wording for a
 * failed read ("couldn't load") or write ("couldn't save").
 */
export function plainError(err: unknown, action: 'save' | 'load' = 'save'): { message: string; status: number | null } {
  if (err instanceof ListsApiError) {
    if (err.status >= 500) return { message: action === 'load' ? LOAD_FAILED_MESSAGE : SAVE_FAILED_MESSAGE, status: err.status }
    return { message: err.message, status: err.status > 0 ? err.status : null }
  }
  return { message: OFFLINE_MESSAGE, status: null }
}

export interface ChipError {
  groupId: string
  /** What was asked: true = add, false = remove. */
  value: boolean
  message: string
  /** The HTTP status, or null when the CRM couldn't be reached. */
  status: number | null
}

export interface ChipControllerOptions {
  leadId: string
  memberOf: readonly string[]
  api?: ChipApi
  /** A change didn't save: its chip has gone back. */
  onError?: (e: ChipError) => void
  /** Every request has finished and something changed: the lead's groups now. */
  onSettled?: (memberOf: string[]) => void
  /** Tell the sidebar and other chip rows (counts). Default: notifyListsChanged(). */
  notify?: () => void
}

/**
 * The chips of one lead. Not React-specific: GroupChips subscribes to it with
 * useSyncExternalStore, and the tests drive it with a stubbed fetch.
 */
export class GroupChipsController {
  readonly leadId: string
  private state: ChipState
  private readonly listeners = new Set<() => void>()
  private readonly inflight = new Set<Promise<void>>()
  private changed = false

  constructor(private readonly opts: ChipControllerOptions) {
    this.leadId = opts.leadId
    this.state = initChipState(opts.memberOf)
  }

  getState = (): ChipState => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** One click (or key) on a chip. */
  toggle(groupId: string): void {
    this.dispatch({ type: 'toggle', groupId })
    this.pump()
  }

  /** The page has newer rows for this lead (e.g. after a bulk change). */
  reset(memberOf: readonly string[]): void {
    this.dispatch({ type: 'reset', memberOf })
    this.pump()
  }

  /**
   * "+": make a group with this name and add the lead to it in one request.
   * Rejects with the plain-English reason (e.g. the name is taken) for the
   * inline error; nothing lights up then.
   */
  async createAndAdd(rawName: string): Promise<GroupDTO> {
    const problem = nameProblem(rawName)
    if (problem) throw new ListsApiError(400, problem)
    let created: { group: GroupDTO }
    try {
      created = await this.api.create({ name: normalizeName(rawName), leadId: this.leadId })
    } catch (err) {
      throw err instanceof ListsApiError ? err : new ListsApiError(0, OFFLINE_MESSAGE)
    }
    const { group } = created
    this.dispatch({ type: 'confirmed', groupId: group.id, value: true })
    this.changed = true
    this.settle()
    return group
  }

  /** Resolves once nothing is on its way to the CRM. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
  }

  private get api(): ChipApi {
    return this.opts.api ?? CRM_CHIP_API
  }

  private dispatch(action: ChipAction): void {
    const next = chipReducer(this.state, action)
    if (next === this.state) return
    this.state = next
    for (const fn of this.listeners) fn()
  }

  private pump(): void {
    for (const { groupId, value } of nextSends(this.state)) {
      this.dispatch({ type: 'send', groupId, value })
      let request: Promise<unknown>
      try {
        request = value ? this.api.add(groupId, this.leadId) : this.api.remove(groupId, this.leadId)
      } catch (err) {
        request = Promise.reject(err)
      }
      const done: Promise<void> = request
        .then(
          () => {
            this.changed = true
            this.dispatch({ type: 'confirmed', groupId, value })
          },
          (err: unknown) => {
            this.dispatch({ type: 'failed', groupId, value })
            this.opts.onError?.({ groupId, value, ...plainError(err) })
          },
        )
        .finally(() => {
          this.inflight.delete(done)
          this.pump()
          this.settle()
        })
      this.inflight.add(done)
    }
    this.settle()
  }

  // Once everything is in, tell the page and the sidebar, once per burst of clicks.
  private settle(): void {
    if (!this.changed || !isSettled(this.state)) return
    this.changed = false
    ;(this.opts.notify ?? notifyListsChanged)()
    this.opts.onSettled?.([...this.state.confirmed])
  }
}
