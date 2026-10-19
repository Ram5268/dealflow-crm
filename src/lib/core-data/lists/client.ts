'use client'

// Brief 45 — the browser's way to the folders / lists / groups / Pipeline API
// (/api/core-data/**). Typed wrappers for every route, plus:
//  - notifyListsChanged(): call after any change, so every sidebar, chip row
//    and count reloads;
//  - useSidebarData(): the sidebar's data, loaded once and shared by every
//    component that asks (a page of 100 rows with group chips is still one
//    request), reloaded on notifyListsChanged().
// Browser-safe: imports only ./types (and React). Errors carry the API's
// plain-English message, ready to show in a toast.
import { useEffect, useSyncExternalStore } from 'react'
import type {
  BulkAddResult, BulkRemoveResult, FolderDTO, GroupColor, GroupDTO, LeadMemberships, ListDTO, MemberFilters,
  PipelineQuery, PipelineResult, RankedPage, SidebarData, WorkflowDTO, WorkflowInput,
} from './types'

const BASE = '/api/core-data'
export const LISTS_CHANGED_EVENT = 'crm:lists-changed'

export class ListsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ListsApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = data && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : null
    throw new ListsApiError(res.status, message ?? `Something went wrong (${res.status}). Please try again.`)
  }
  return data as T
}

const enc = encodeURIComponent

/** A query string from defined, non-empty values; true → '1'. */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    sp.set(k, v === true ? '1' : String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

const memberQs = (opts: { page?: number; filters?: MemberFilters; ids?: boolean } = {}) =>
  qs({ page: opts.page, ids: opts.ids, ...opts.filters })

export function pipelineQs(q: PipelineQuery): string {
  return qs({ view: q.view, groups: q.groups?.join(','), ...q.filters, column: q.column, page: q.page, sort: q.sort, dir: q.dir })
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
export const getSidebar = () => request<SidebarData>('GET', '/sidebar')

// ─── Folders ─────────────────────────────────────────────────────────────────
export const createFolder = (name: string) =>
  request<{ folder: FolderDTO }>('POST', '/folders', { name }).then((r) => r.folder)
export const renameFolder = (id: string, name: string) =>
  request<{ folder: FolderDTO }>('PATCH', `/folders/${enc(id)}`, { name }).then((r) => r.folder)
export const deleteFolder = (id: string) => request<{ deleted: true }>('DELETE', `/folders/${enc(id)}`)
export const reorderFolders = (ids: string[]) => request<{ ok: true }>('POST', '/folders/reorder', { ids })

// ─── Lists ───────────────────────────────────────────────────────────────────
export const getLists = (opts: { archived?: boolean } = {}) =>
  request<{ lists: ListDTO[] }>('GET', `/lists${qs({ archived: opts.archived })}`).then((r) => r.lists)
export const createList = (input: { name: string; folderId?: string | null; leadIds?: string[] }) =>
  request<{ list: ListDTO; added: number; notFound: number }>('POST', '/lists', input)
export const updateList = (id: string, patch: { name?: string; folderId?: string | null; archived?: boolean }) =>
  request<{ list: ListDTO }>('PATCH', `/lists/${enc(id)}`, patch).then((r) => r.list)
export const deleteList = (id: string) =>
  request<{ deleted: true; membershipsRemoved: number }>('DELETE', `/lists/${enc(id)}`)
export const reorderLists = (folderId: string | null, ids: string[]) =>
  request<{ ok: true }>('POST', '/lists/reorder', { folderId, ids })

export const getListMembers = (id: string, opts: { page?: number; filters?: MemberFilters } = {}) =>
  request<RankedPage>('GET', `/lists/${enc(id)}/members${memberQs(opts)}`)
export const getListMemberIds = (id: string, filters: MemberFilters = {}) =>
  request<{ ids: string[] }>('GET', `/lists/${enc(id)}/members${memberQs({ filters, ids: true })}`).then((r) => r.ids)
export const addListMembers = (id: string, leadIds: string[]) =>
  request<BulkAddResult>('POST', `/lists/${enc(id)}/members`, { leadIds })
export const removeListMembers = (id: string, leadIds: string[]) =>
  request<BulkRemoveResult>('DELETE', `/lists/${enc(id)}/members`, { leadIds })
/** For a download link (the browser saves the CSV). */
export const listExportUrl = (id: string, filters: MemberFilters = {}) => `${BASE}/lists/${enc(id)}/export${memberQs({ filters })}`

// ─── All leads ───────────────────────────────────────────────────────────────
export const getAllLeads = (opts: { page?: number; filters?: MemberFilters } = {}) =>
  request<RankedPage>('GET', `/all-leads${memberQs(opts)}`)
export const getAllLeadIds = (filters: MemberFilters = {}) =>
  request<{ ids: string[] }>('GET', `/all-leads${memberQs({ filters, ids: true })}`).then((r) => r.ids)
export const allLeadsExportUrl = (filters: MemberFilters = {}) => `${BASE}/all-leads/export${memberQs({ filters })}`

// ─── Groups ──────────────────────────────────────────────────────────────────
export const getGroups = () => request<{ groups: GroupDTO[] }>('GET', '/groups').then((r) => r.groups)
/** With leadId: the "+" chip (create the group and add that lead in one step). */
export const createGroup = (input: { name: string; color?: GroupColor; leadId?: string }) =>
  request<{ group: GroupDTO; added: number }>('POST', '/groups', input)
export const updateGroup = (id: string, patch: { name?: string; color?: GroupColor }) =>
  request<{ group: GroupDTO }>('PATCH', `/groups/${enc(id)}`, patch).then((r) => r.group)
export const deleteGroup = (id: string) =>
  request<{ deleted: true; membershipsRemoved: number }>('DELETE', `/groups/${enc(id)}`)
export const reorderGroups = (ids: string[]) => request<{ ok: true }>('POST', '/groups/reorder', { ids })
export const addLeadToGroup = (groupId: string, leadId: string) =>
  request<{ changed: boolean }>('PUT', `/groups/${enc(groupId)}/members/${enc(leadId)}`)
export const removeLeadFromGroup = (groupId: string, leadId: string) =>
  request<{ changed: boolean }>('DELETE', `/groups/${enc(groupId)}/members/${enc(leadId)}`)
export const addGroupMembers = (groupId: string, leadIds: string[]) =>
  request<BulkAddResult>('POST', `/groups/${enc(groupId)}/members`, { leadIds })
export const removeGroupMembers = (groupId: string, leadIds: string[]) =>
  request<BulkRemoveResult>('DELETE', `/groups/${enc(groupId)}/members`, { leadIds })
/** A Pipeline drag: out of one group, into another, in one step. */
export const moveLeadBetweenGroups = (input: { leadId: string; fromGroupId: string; toGroupId: string }) =>
  request<{ ok: true; removed: boolean; added: boolean }>('POST', '/groups/move', input)

export const getLeadMemberships = (leadId: string) => request<LeadMemberships>('GET', `/leads/${enc(leadId)}/memberships`)

// ─── Pipeline and saved workflows ────────────────────────────────────────────
export const getPipeline = (query: PipelineQuery) => request<PipelineResult>('GET', `/pipeline${pipelineQs(query)}`)
export const getWorkflows = () => request<{ workflows: WorkflowDTO[] }>('GET', '/workflows').then((r) => r.workflows)
export const createWorkflow = (input: WorkflowInput) =>
  request<{ workflow: WorkflowDTO }>('POST', '/workflows', input).then((r) => r.workflow)
export const updateWorkflow = (id: string, patch: Partial<WorkflowInput>) =>
  request<{ workflow: WorkflowDTO }>('PATCH', `/workflows/${enc(id)}`, patch).then((r) => r.workflow)
export const deleteWorkflow = (id: string) => request<{ deleted: true }>('DELETE', `/workflows/${enc(id)}`)

// ─── Change notification and the shared sidebar data ────────────────────────

/** Tell every open sidebar, chip row and count that folders/lists/groups changed. */
export function notifyListsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LISTS_CHANGED_EVENT))
}

export interface SidebarState {
  data: SidebarData | null
  error: string | null
  loading: boolean
}

const INITIAL: SidebarState = { data: null, error: null, loading: false }
let state: SidebarState = INITIAL
let generation = 0
const subscribers = new Set<() => void>()

function setState(next: Partial<SidebarState>): void {
  state = { ...state, ...next }
  for (const fn of subscribers) fn()
}

/**
 * Shown when the sidebar's data can't load because of a server error (5xx) or
 * no connection: plain English, never the server's own text. Every place that
 * shows it adds a "Try again" button right after it (Brief 45 PR C review).
 */
export const SIDEBAR_LOAD_FAILED = "Couldn't load your lists and groups just now."

/** The store's error for a failed load: the API's own words for a refusal it wrote for people, plain English otherwise. */
export function sidebarLoadError(err: unknown): string {
  return err instanceof ListsApiError && err.status > 0 && err.status < 500 ? err.message : SIDEBAR_LOAD_FAILED
}

/** Load the sidebar again (keeps showing the old data meanwhile); the newest load wins. */
export function reloadSidebar(): Promise<void> {
  const gen = ++generation
  setState({ loading: true })
  return getSidebar().then(
    (data) => {
      if (gen === generation) setState({ data, error: null, loading: false })
    },
    (err: unknown) => {
      if (gen === generation) setState({ error: sidebarLoadError(err), loading: false })
    },
  )
}

/** The shared sidebar data as it is now (for callers outside React, and the tests). */
export function getSidebarState(): SidebarState {
  return state
}

const onChanged = () => void reloadSidebar()

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  if (subscribers.size === 1) window.addEventListener(LISTS_CHANGED_EVENT, onChanged)
  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) window.removeEventListener(LISTS_CHANGED_EVENT, onChanged)
  }
}

/** The sidebar's data (folders, lists, groups, workflows, All leads), shared and live. */
export function useSidebarData(): SidebarState & { reload: () => Promise<void> } {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL)
  useEffect(() => {
    if (!state.data && !state.loading && !state.error) void reloadSidebar()
  }, [])
  return { ...snapshot, reload: reloadSidebar }
}
