import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ListsApiError,
  SIDEBAR_LOAD_FAILED,
  getSidebarState,
  reloadSidebar,
  sidebarLoadError,
} from '@/lib/core-data/lists/client'

// Brief 45 (PR C review): when the sidebar's data (folders, lists, groups)
// can't load, the sidebar, the group chips and the bulk dialogs say so in
// plain English, never the server's own text such as "Internal error". Every
// place that shows it puts a "Try again" button right after it, so on screen
// it reads "Couldn't load your lists and groups just now. Try again".

const respond = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the shared sidebar data when /api/core-data/sidebar fails', () => {
  it('a server error reads in plain English, not the server’s text', async () => {
    respond(500, { error: 'Internal error' })
    await reloadSidebar()
    expect(getSidebarState()).toMatchObject({ error: "Couldn't load your lists and groups just now.", loading: false })
  })

  it('no connection reads the same', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await reloadSidebar()
    expect(getSidebarState().error).toBe(SIDEBAR_LOAD_FAILED)
  })

  it('a refusal the API words for people is shown as written; any 5xx is plain English', () => {
    expect(sidebarLoadError(new ListsApiError(403, 'You need to sign in again.'))).toBe('You need to sign in again.')
    expect(sidebarLoadError(new ListsApiError(502, 'Bad gateway'))).toBe(SIDEBAR_LOAD_FAILED)
    expect(sidebarLoadError(new Error('boom'))).toBe(SIDEBAR_LOAD_FAILED)
  })

  it('a good load clears the error', async () => {
    respond(200, { allLeads: { count: 0, rankedAt: null }, folders: [], lists: [], archivedCount: 0, groups: [], workflows: [] })
    await reloadSidebar()
    expect(getSidebarState()).toMatchObject({ error: null, loading: false })
    expect(getSidebarState().data?.groups).toEqual([])
  })
})
