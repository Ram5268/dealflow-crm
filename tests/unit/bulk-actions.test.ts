import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  bulkMenuEntries,
  bulkResultText,
  chunkIds,
  runBulk,
  selectAllOffer,
  type BulkTotals,
} from '@/components/lists/bulk-actions'
import { BULK_MAX } from '@/lib/core-data/lists/types'

// Brief 45 PR C — bulk actions on Leads, list pages and the Pipeline table
// [brief §5.4]: Add to group · Remove from group · Add to list (existing or
// new) · Remove from this list · Export CSV. The API takes at most 5,000 ids a
// request [engineering precaution, CONTRACT §2], so bigger selections go in
// chunks. Results read in plain English. Nothing here contacts anyone.

const ids = (n: number, prefix = 'lead_') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
const totals = (t: Partial<BulkTotals>): BulkTotals => ({ requested: 0, added: 0, alreadyIn: 0, notFound: 0, removed: 0, ...t })

describe('chunking at 5,000', () => {
  it('splits a selection into requests of at most 5,000, in order, each person once', () => {
    expect(BULK_MAX).toBe(5_000)
    expect(chunkIds([])).toEqual([])
    expect(chunkIds(['a'])).toEqual([['a']])
    expect(chunkIds(ids(5_000)).map((c) => c.length)).toEqual([5_000])
    expect(chunkIds(ids(5_001)).map((c) => c.length)).toEqual([5_000, 1])
    const big = chunkIds(ids(12_345))
    expect(big.map((c) => c.length)).toEqual([5_000, 5_000, 2_345])
    expect(big.flat()).toEqual(ids(12_345))
    expect(chunkIds(['a', 'b', 'a', 'c', 'b'])).toEqual([['a', 'b', 'c']])
    expect(chunkIds(ids(5), 2)).toEqual([['lead_1', 'lead_2'], ['lead_3', 'lead_4'], ['lead_5']])
  })
})

describe('results in plain English', () => {
  it('add to a group', () => {
    expect(bulkResultText('addToGroup', totals({ requested: 45, added: 42, alreadyIn: 3 }), 'Hot')).toBe(
      'Added 42 people to Hot · 3 were already in it',
    )
    expect(bulkResultText('addToGroup', totals({ requested: 1, added: 1 }), 'Hot')).toBe('Added 1 person to Hot')
    expect(bulkResultText('addToGroup', totals({ requested: 2, added: 1, alreadyIn: 1 }), 'Hot')).toBe(
      'Added 1 person to Hot · 1 was already in it',
    )
    expect(bulkResultText('addToGroup', totals({ requested: 3, alreadyIn: 3 }), 'Hot')).toBe('All 3 were already in Hot')
    expect(bulkResultText('addToGroup', totals({ requested: 1_489, added: 1_487, notFound: 2 }), 'Nurture')).toBe(
      "Added 1,487 people to Nurture · 2 couldn't be found",
    )
  })

  it('remove from a group', () => {
    expect(bulkResultText('removeFromGroup', totals({ requested: 42, removed: 40 }), 'Hot')).toBe(
      "Removed 40 people from Hot · 2 weren't in it",
    )
    expect(bulkResultText('removeFromGroup', totals({ requested: 1, removed: 1 }), 'Hot')).toBe('Removed 1 person from Hot')
    expect(bulkResultText('removeFromGroup', totals({ requested: 5, removed: 0 }), 'Hot')).toBe('None of the 5 were in Hot')
  })

  it('add to a list (existing or new)', () => {
    expect(bulkResultText('addToList', totals({ requested: 45, added: 42, alreadyIn: 3 }), 'Expireds – Oct 2026')).toBe(
      'Added 42 people to Expireds – Oct 2026 · 3 were already on it',
    )
    expect(bulkResultText('addToList', totals({ requested: 4, alreadyIn: 4 }), 'Referrals')).toBe('All 4 were already on Referrals')
    expect(bulkResultText('newList', totals({ requested: 42, added: 42 }), 'Callbacks')).toBe('Made the list Callbacks with 42 people')
    expect(bulkResultText('newList', totals({ requested: 1, added: 1 }), 'Callbacks')).toBe('Made the list Callbacks with 1 person')
  })

  it('remove from this list: says the people stay in the CRM', () => {
    expect(bulkResultText('removeFromThisList', totals({ requested: 42, removed: 42 }), 'Expireds – Oct 2026')).toBe(
      'Removed 42 people from Expireds – Oct 2026 · they stay in the CRM',
    )
    expect(bulkResultText('removeFromThisList', totals({ requested: 1, removed: 1 }), 'Referrals')).toBe(
      'Removed 1 person from Referrals · they stay in the CRM',
    )
  })
})

describe('the menu', () => {
  it('"Remove from this list" only on a list', () => {
    expect(bulkMenuEntries({})).toEqual(['addToGroup', 'removeFromGroup', 'addToList'])
    expect(bulkMenuEntries({ listId: 'list_1' })).toEqual(['addToGroup', 'removeFromGroup', 'addToList', 'removeFromThisList'])
    expect(bulkMenuEntries({ canExport: true })).toEqual(['addToGroup', 'removeFromGroup', 'addToList', 'export'])
    expect(bulkMenuEntries({ listId: 'list_1', canExport: true })).toEqual([
      'addToGroup', 'removeFromGroup', 'addToList', 'removeFromThisList', 'export',
    ])
  })
})

describe('"Select all N matching"', () => {
  const page = ids(50)
  it('is offered once the whole page is selected and more people match', () => {
    expect(selectAllOffer({ pageIds: page, selected: new Set(page.slice(0, 10)), total: 1_489 })).toEqual({ kind: 'none' })
    expect(selectAllOffer({ pageIds: page, selected: new Set(page), total: 1_489 })).toEqual({ kind: 'offer', pageCount: 50, total: 1_489 })
    expect(selectAllOffer({ pageIds: page, selected: new Set(page), total: 50 })).toEqual({ kind: 'none' })
    expect(selectAllOffer({ pageIds: [], selected: new Set(), total: 0 })).toEqual({ kind: 'none' })
  })
  it('then says everyone matching is selected (capped at 25,000 at once)', () => {
    expect(selectAllOffer({ pageIds: page, selected: new Set(ids(1_489)), total: 1_489 })).toEqual({ kind: 'all', count: 1_489, capped: false })
    expect(selectAllOffer({ pageIds: page, selected: new Set(ids(25_000)), total: 30_000 })).toEqual({ kind: 'all', count: 25_000, capped: true })
  })
})

// ─── The requests (fetch stubbed; no server, no database) ───────────────────

type Call = { method: string; url: string; body: { leadIds?: string[]; name?: string; folderId?: string | null } | undefined }

function stubFetch(respond: (call: Call, n: number) => { status: number; body: unknown }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const r = respond(call, calls.length)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runBulk', () => {
  it('add to group: 12,000 people go as 5,000 + 5,000 + 2,000, and the counts add up', async () => {
    const calls = stubFetch((c) => {
      const n = c.body!.leadIds!.length
      return { status: 200, body: { added: n === 2_000 ? 1_990 : n, alreadyIn: n === 2_000 ? 10 : 0, notFound: 0 } }
    })
    const progress: number[] = []
    const r = await runBulk({ kind: 'addToGroup', groupId: 'grp_hot', name: 'Hot' }, ids(12_000), (done) => progress.push(done))
    expect(calls.map((c) => `${c.method} ${c.url} ${c.body!.leadIds!.length}`)).toEqual([
      'POST /api/core-data/groups/grp_hot/members 5000',
      'POST /api/core-data/groups/grp_hot/members 5000',
      'POST /api/core-data/groups/grp_hot/members 2000',
    ])
    expect(calls.flatMap((c) => c.body!.leadIds!)).toEqual(ids(12_000))
    expect(progress).toEqual([5_000, 10_000, 12_000])
    expect(r.error).toBeNull()
    expect(r.totals).toEqual(totals({ requested: 12_000, added: 11_990, alreadyIn: 10 }))
    expect(r.text).toBe('Added 11,990 people to Hot · 10 were already in it')
  })

  it('remove from group → DELETE /api/core-data/groups/<id>/members', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { removed: 2 } }))
    const r = await runBulk({ kind: 'removeFromGroup', groupId: 'grp_hot', name: 'Hot' }, ids(3))
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/core-data/groups/grp_hot/members', body: { leadIds: ids(3) } }])
    expect(r.text).toBe("Removed 2 people from Hot · 1 wasn't in it")
  })

  it('add to an existing list → POST /api/core-data/lists/<id>/members', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { added: 3, alreadyIn: 0, notFound: 0 } }))
    const r = await runBulk({ kind: 'addToList', listId: 'list_1', name: 'Referrals' }, ids(3))
    expect(calls).toEqual([{ method: 'POST', url: '/api/core-data/lists/list_1/members', body: { leadIds: ids(3) } }])
    expect(r.text).toBe('Added 3 people to Referrals')
  })

  it('a new list with 7,000 people: created with the first 5,000, then the rest added to it', async () => {
    const calls = stubFetch((c) =>
      c.url === '/api/core-data/lists'
        ? { status: 201, body: { list: { id: 'list_new', name: 'Callbacks' }, added: 5_000, notFound: 0 } }
        : { status: 200, body: { added: 2_000, alreadyIn: 0, notFound: 0 } },
    )
    const r = await runBulk({ kind: 'newList', name: 'Callbacks', folderId: 'fld_1' }, ids(7_000))
    expect(calls.map((c) => `${c.method} ${c.url} ${c.body!.leadIds!.length}`)).toEqual([
      'POST /api/core-data/lists 5000',
      'POST /api/core-data/lists/list_new/members 2000',
    ])
    expect(calls[0].body).toMatchObject({ name: 'Callbacks', folderId: 'fld_1' })
    expect(r.listId).toBe('list_new')
    expect(r.text).toBe('Made the list Callbacks with 7,000 people')
  })

  it('remove from this list → DELETE /api/core-data/lists/<id>/members', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { removed: 2 } }))
    const r = await runBulk({ kind: 'removeFromThisList', listId: 'list_1', name: 'Referrals' }, ids(2))
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/core-data/lists/list_1/members', body: { leadIds: ids(2) } }])
    expect(r.text).toBe('Removed 2 people from Referrals · they stay in the CRM')
  })

  it('stops at the first refusal and says what was done so far', async () => {
    stubFetch((_c, n) => (n === 1 ? { status: 200, body: { added: 5_000, alreadyIn: 0, notFound: 0 } } : { status: 404, body: { error: 'Group not found.' } }))
    const r = await runBulk({ kind: 'addToGroup', groupId: 'grp_hot', name: 'Hot' }, ids(6_000))
    expect(r.error).toBe('Group not found.')
    expect(r.totals.added).toBe(5_000)
    expect(r.text).toBe('Added 5,000 people to Hot, then stopped: Group not found. Trying again is safe: people already in it are skipped.')
  })

  it('a refusal on the first request: just the reason', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'A list named "Callbacks" is already outside folders.' } }))
    const r = await runBulk({ kind: 'newList', name: 'Callbacks', folderId: null }, ids(2))
    expect(r.error).toBe('A list named "Callbacks" is already outside folders.')
    expect(r.text).toBe('A list named "Callbacks" is already outside folders.')
    expect(r.listId).toBeNull()
  })

  it('a server error part way reads as plain English', async () => {
    stubFetch((_c, n) => (n === 1 ? { status: 200, body: { removed: 5_000 } } : { status: 502, body: { error: 'Bad gateway' } }))
    const r = await runBulk({ kind: 'removeFromGroup', groupId: 'grp_hot', name: 'Hot' }, ids(5_001))
    expect(r.error).toBe("The CRM couldn't save that just now. Please try again.")
    expect(r.text).toBe(
      "Removed 5,000 people from Hot, then stopped: The CRM couldn't save that just now. Please try again. Trying again is safe.",
    )
  })

  it('an empty selection is refused before anything is sent: no list is made', async () => {
    const calls = stubFetch(() => ({ status: 201, body: { list: { id: 'list_new', name: 'Empty' }, added: 0, notFound: 0 } }))
    for (const op of [
      { kind: 'newList', name: 'Empty', folderId: null },
      { kind: 'addToGroup', groupId: 'grp_hot', name: 'Hot' },
      { kind: 'removeFromThisList', listId: 'list_1', name: 'Referrals' },
    ] as const) {
      const r = await runBulk(op, [])
      expect(r).toEqual({
        totals: totals({}),
        text: 'Select at least one person first.',
        error: 'Select at least one person first.',
        listId: null,
      })
    }
    expect(calls).toEqual([])
  })
})
