import { describe, it, expect, vi, afterEach } from 'vitest'
import { cardKeyAction } from '@/app/pipeline/keys'
import { matchesWorkflow, workflowHref, workflowInput, workflowToQuery } from '@/app/pipeline/workflows'
import {
  createGroupNamed, fetchColumnPage, moveCard, moveFailure, removeWorkflow, renameWorkflow, saveOverWorkflow, saveWorkflow,
} from '@/app/pipeline/api'
import type { KeyEventLike } from '@/lib/ui/hotkeys'
import { GROUPS, HOT, NURTURE, WORKFLOWS } from './helpers/pipeline-fixtures'

// Brief 45 PR D — the Pipeline's keyboard moves, saved workflows, and the
// exact requests the page sends to PR A's API (fetch is stubbed: no network).

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
const onCard = { onCard: true, editable: false }

describe('keyboard: every drag has a key [brief §7]', () => {
  it('[ and ] move the focused card to the previous / next column; M opens "Move to group…"', () => {
    expect(cardKeyAction(key('['), onCard)).toEqual({ type: 'move', dir: -1 })
    expect(cardKeyAction(key(']'), onCard)).toEqual({ type: 'move', dir: 1 })
    expect(cardKeyAction(key('m'), onCard)).toEqual({ type: 'menu' })
    expect(cardKeyAction(key('M', { shiftKey: true }), onCard)).toEqual({ type: 'menu' })
    expect(cardKeyAction(key('F10', { shiftKey: true }), onCard)).toEqual({ type: 'menu' })
    expect(cardKeyAction(key('ContextMenu'), onCard)).toEqual({ type: 'menu' })
    // From the card's own buttons too (focus inside the card).
    expect(cardKeyAction(key(']'), { onCard: false, editable: false })).toEqual({ type: 'move', dir: 1 })
  })

  it('arrows walk the board and Enter opens the lead, on the card itself only', () => {
    expect(cardKeyAction(key('ArrowDown'), onCard)).toEqual({ type: 'focus', within: 'column', delta: 1 })
    expect(cardKeyAction(key('ArrowUp'), onCard)).toEqual({ type: 'focus', within: 'column', delta: -1 })
    expect(cardKeyAction(key('ArrowRight'), onCard)).toEqual({ type: 'focus', within: 'row', delta: 1 })
    expect(cardKeyAction(key('ArrowLeft'), onCard)).toEqual({ type: 'focus', within: 'row', delta: -1 })
    expect(cardKeyAction(key('Enter'), onCard)).toEqual({ type: 'open' })
    // On the card's "⋯" button, Enter presses the button, not the card.
    expect(cardKeyAction(key('Enter'), { onCard: false, editable: false })).toBeNull()
    expect(cardKeyAction(key('ArrowDown'), { onCard: false, editable: false })).toBeNull()
  })

  it('never fires while typing, or with ⌘ / Ctrl / Option held', () => {
    for (const k of ['[', ']', 'm', 'ArrowDown', 'Enter']) {
      expect(cardKeyAction(key(k), { onCard: true, editable: true })).toBeNull()
      expect(cardKeyAction(key(k, { metaKey: true }), onCard)).toBeNull()
      expect(cardKeyAction(key(k, { ctrlKey: true }), onCard)).toBeNull()
      expect(cardKeyAction(key(k, { altKey: true }), onCard)).toBeNull()
    }
    expect(cardKeyAction(key('x'), onCard)).toBeNull()
  })
})

describe('saved workflows [brief §5.6]', () => {
  const [brown, expired] = WORKFLOWS

  it('a tab opens by its id', () => {
    expect(workflowHref('wf_brown')).toBe('/pipeline?wf=wf_brown')
  })

  it('applying one restores its filters, columns, view and sort', () => {
    expect(workflowToQuery(brown, GROUPS)).toEqual({ query: { view: 'board', groups: [NURTURE.id], filters: { borough: 'Brooklyn' } }, missingGroups: 0 })
    expect(workflowToQuery(expired, GROUPS).query).toEqual({
      view: 'table', groups: [HOT.id], filters: { list: 'l_oct', tier: 'hot' }, sort: 'lastContact', dir: 'desc',
    })
  })

  it('a workflow whose group was deleted still opens: with the groups that are left, or every group', () => {
    const someGone = { ...brown, groupIds: ['g_deleted', NURTURE.id] }
    expect(workflowToQuery(someGone, GROUPS)).toEqual({ query: { view: 'board', groups: [NURTURE.id], filters: { borough: 'Brooklyn' } }, missingGroups: 1 })
    const allGone = { ...brown, groupIds: ['g_deleted'] }
    expect(workflowToQuery(allGone, GROUPS)).toEqual({ query: { view: 'board', filters: { borough: 'Brooklyn' } }, missingGroups: 1 })
  })

  it('saves exactly what is on screen (every group = no list, so new groups show too)', () => {
    expect(workflowInput({ view: 'board', filters: { multiGroup: '1' } })).toEqual({ view: 'board', filters: { multiGroup: '1' }, groupIds: [], sort: null })
    expect(workflowInput({ view: 'table', groups: [HOT.id], filters: {}, sort: 'name', page: 3 })).toEqual({
      view: 'table', filters: {}, groupIds: [HOT.id], sort: { key: 'name', dir: 'asc' },
    })
    expect(workflowInput({ view: 'table', filters: {}, sort: 'rank', dir: 'desc' }).sort).toEqual({ key: 'rank', dir: 'desc' })
  })

  it('knows when the screen no longer matches the open workflow (to offer "Update")', () => {
    const q = workflowToQuery(brown, GROUPS).query
    expect(matchesWorkflow(q, brown, GROUPS)).toBe(true)
    expect(matchesWorkflow({ ...q, page: 2 }, brown, GROUPS)).toBe(true) // the page isn't saved
    expect(matchesWorkflow({ ...q, filters: { borough: 'Queens' } }, brown, GROUPS)).toBe(false)
    expect(matchesWorkflow({ ...q, view: 'table' }, brown, GROUPS)).toBe(false)
    expect(matchesWorkflow({ ...q, groups: undefined }, brown, GROUPS)).toBe(false)
  })
})

describe('the requests the page sends (PR A routes)', () => {
  const calls: { url: string; method: string; body: unknown }[] = []
  function stubFetch(status = 200, body: unknown = {}) {
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }))
  }
  afterEach(() => vi.unstubAllGlobals())

  it('a drag is one move: out of X, into Y', async () => {
    stubFetch(200, { ok: true, removed: true, added: true })
    await moveCard({ leadId: 'lead_2', fromGroupId: HOT.id, toGroupId: NURTURE.id })
    expect(calls).toEqual([{ url: '/api/core-data/groups/move', method: 'POST', body: { leadId: 'lead_2', fromGroupId: HOT.id, toGroupId: NURTURE.id } }])
  })

  it('a refused move rolls back with the server reason, in plain English', async () => {
    stubFetch(404, { error: 'Group not found.' })
    const err = await moveCard({ leadId: 'lead_2', fromGroupId: HOT.id, toGroupId: 'g_gone' }).catch((e: unknown) => e)
    expect(moveFailure('Test Owner 2', 'Nurture', err)).toEqual({ title: "Couldn't move Test Owner 2 to Nurture", description: 'Group not found.', tone: 'danger' })
    expect(moveFailure('Test Owner 2', 'Nurture', new TypeError('fetch failed')).description).toBe('The CRM could not be reached. Check your connection and try again.')
  })

  it('save, update, rename and delete a workflow', async () => {
    stubFetch(201, { workflow: WORKFLOWS[0] })
    await saveWorkflow('Brownstone nurtures', { view: 'board', groups: [NURTURE.id], filters: { borough: 'Brooklyn' } })
    expect(calls.at(-1)).toEqual({
      url: '/api/core-data/workflows', method: 'POST',
      body: { name: 'Brownstone nurtures', view: 'board', filters: { borough: 'Brooklyn' }, groupIds: [NURTURE.id], sort: null },
    })
    stubFetch(200, { workflow: WORKFLOWS[0] })
    await saveOverWorkflow('wf_brown', { view: 'table', filters: { tier: 'warm' }, sort: 'taskDue', dir: 'desc' })
    expect(calls.at(-1)).toEqual({
      url: '/api/core-data/workflows/wf_brown', method: 'PATCH',
      body: { view: 'table', filters: { tier: 'warm' }, groupIds: [], sort: { key: 'taskDue', dir: 'desc' } },
    })
    await renameWorkflow('wf_brown', 'Brownstones')
    expect(calls.at(-1)).toEqual({ url: '/api/core-data/workflows/wf_brown', method: 'PATCH', body: { name: 'Brownstones' } })
    stubFetch(200, { deleted: true })
    await removeWorkflow('wf_brown')
    expect(calls.at(-1)).toEqual({ url: '/api/core-data/workflows/wf_brown', method: 'DELETE', body: undefined })
  })

  it('a duplicate name comes back as the API says it', async () => {
    stubFetch(409, { error: 'A workflow named "Brownstone nurtures" already exists.' })
    await expect(saveWorkflow('brownstone NURTURES', { view: 'board', filters: {} })).rejects.toThrow('A workflow named "Brownstone nurtures" already exists.')
  })

  it('"load more" asks for one column\'s next page with the same filters', async () => {
    stubFetch(200, { view: 'board', columns: [{ group: HOT, count: 60, cards: [], hasMore: false, page: 2 }], filterOptions: {} })
    const col = await fetchColumnPage({ view: 'board', groups: [HOT.id, NURTURE.id], filters: { units: '5+' } }, HOT.id, 2)
    expect(col).toMatchObject({ group: { id: HOT.id }, page: 2 })
    const url = new URL(calls[0].url, 'http://x')
    expect(url.pathname).toBe('/api/core-data/pipeline')
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'board', groups: `${HOT.id},${NURTURE.id}`, units: '5+', column: HOT.id, page: '2' })
  })

  it('"+ Group" on the empty Pipeline creates the group by name', async () => {
    stubFetch(201, { group: HOT, added: 0 })
    expect(await createGroupNamed('Hot')).toEqual(HOT)
    expect(calls).toEqual([{ url: '/api/core-data/groups', method: 'POST', body: { name: 'Hot' } }])
  })
})
