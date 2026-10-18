import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  GroupChipsController,
  chipReducer,
  initChipState,
  isOn,
  isSettled,
  litGroupIds,
  nextSends,
  type ChipState,
} from '@/components/lists/group-chips-state'

// Brief 45 PR C — the group chips on a lead's contact card [brief §5.3]: one
// click adds the lead to that group and the chip lights up at once; a second
// click removes it. No menus, no save button. Changes are optimistic and go
// back, with a plain-English toast, when the CRM refuses them.
// Made-up ids only.

const LEAD = 'lead_test_1'

function run(state: ChipState, ...actions: Parameters<typeof chipReducer>[1][]): ChipState {
  return actions.reduce(chipReducer, state)
}

describe('the optimistic state (pure reducer)', () => {
  it('toggle on: the chip lights up at once, one request is due, and it stays lit when the CRM confirms', () => {
    let s = run(initChipState([]), { type: 'toggle', groupId: 'hot' })
    expect(isOn(s, 'hot')).toBe(true)
    expect(nextSends(s)).toEqual([{ groupId: 'hot', value: true }])
    s = run(s, { type: 'send', groupId: 'hot', value: true })
    expect(nextSends(s)).toEqual([])
    expect(isOn(s, 'hot')).toBe(true)
    expect(isSettled(s)).toBe(false)
    s = run(s, { type: 'confirmed', groupId: 'hot', value: true })
    expect(isOn(s, 'hot')).toBe(true)
    expect(s.confirmed).toEqual(['hot'])
    expect(isSettled(s)).toBe(true)
  })

  it('toggle off: the chip goes dark at once and stays dark when the CRM confirms', () => {
    let s = run(initChipState(['hot', 'nurture']), { type: 'toggle', groupId: 'hot' })
    expect(isOn(s, 'hot')).toBe(false)
    expect(isOn(s, 'nurture')).toBe(true)
    expect(nextSends(s)).toEqual([{ groupId: 'hot', value: false }])
    s = run(s, { type: 'send', groupId: 'hot', value: false }, { type: 'confirmed', groupId: 'hot', value: false })
    expect(isOn(s, 'hot')).toBe(false)
    expect(s.confirmed).toEqual(['nurture'])
    expect(isSettled(s)).toBe(true)
  })

  it('rollback: a refused add goes back to off, a refused remove goes back to on', () => {
    const add = run(
      initChipState([]),
      { type: 'toggle', groupId: 'hot' },
      { type: 'send', groupId: 'hot', value: true },
      { type: 'failed', groupId: 'hot', value: true },
    )
    expect(isOn(add, 'hot')).toBe(false)
    expect(isSettled(add)).toBe(true)
    expect(nextSends(add)).toEqual([])

    const remove = run(
      initChipState(['hot']),
      { type: 'toggle', groupId: 'hot' },
      { type: 'send', groupId: 'hot', value: false },
      { type: 'failed', groupId: 'hot', value: false },
    )
    expect(isOn(remove, 'hot')).toBe(true)
    expect(isSettled(remove)).toBe(true)
  })

  it('two clicks before anything is sent cancel out: no request at all', () => {
    const s = run(initChipState([]), { type: 'toggle', groupId: 'hot' }, { type: 'toggle', groupId: 'hot' })
    expect(isOn(s, 'hot')).toBe(false)
    expect(nextSends(s)).toEqual([])
    expect(isSettled(s)).toBe(true)
  })

  it('a click while a request is in flight waits for it, then sends the latest wish (one request per chip at a time)', () => {
    let s = run(initChipState([]), { type: 'toggle', groupId: 'hot' }, { type: 'send', groupId: 'hot', value: true })
    s = run(s, { type: 'toggle', groupId: 'hot' }) // changed their mind while the add is in flight
    expect(isOn(s, 'hot')).toBe(false)
    expect(nextSends(s)).toEqual([]) // nothing new until the add comes back
    s = run(s, { type: 'confirmed', groupId: 'hot', value: true })
    expect(isOn(s, 'hot')).toBe(false) // still shows the latest wish
    expect(nextSends(s)).toEqual([{ groupId: 'hot', value: false }])
    s = run(s, { type: 'send', groupId: 'hot', value: false }, { type: 'confirmed', groupId: 'hot', value: false })
    expect(isOn(s, 'hot')).toBe(false)
    expect(isSettled(s)).toBe(true)
  })

  it('a refused request while the person changed their mind leaves the CRM as it was', () => {
    const s = run(
      initChipState([]),
      { type: 'toggle', groupId: 'hot' },
      { type: 'send', groupId: 'hot', value: true },
      { type: 'toggle', groupId: 'hot' },
      { type: 'failed', groupId: 'hot', value: true },
    )
    expect(isOn(s, 'hot')).toBe(false)
    expect(nextSends(s)).toEqual([])
    expect(isSettled(s)).toBe(true)
  })

  it('new rows from the page replace what the CRM confirmed, but keep wishes still in flight', () => {
    let s = run(initChipState(['hot']), { type: 'toggle', groupId: 'nurture' }, { type: 'send', groupId: 'nurture', value: true })
    s = run(s, { type: 'reset', memberOf: ['appointment'] })
    expect(isOn(s, 'hot')).toBe(false)
    expect(isOn(s, 'appointment')).toBe(true)
    expect(isOn(s, 'nurture')).toBe(true) // still in flight: the person's click wins
    s = run(s, { type: 'confirmed', groupId: 'nurture', value: true })
    expect([...s.confirmed].sort()).toEqual(['appointment', 'nurture'])
  })

  it('lit groups come back in the order of the chips (sidebar order)', () => {
    const s = run(initChipState(['c', 'a']), { type: 'toggle', groupId: 'b' })
    expect(litGroupIds(s, ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c'])
  })
})

// ─── The requests the chips send (fetch stubbed; no server, no database) ────

type Call = { method: string; url: string; body: unknown }

function stubFetch(respond: (call: Call) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const r = await respond(call)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

function controller(memberOf: string[], extra: Partial<ConstructorParameters<typeof GroupChipsController>[0]> = {}) {
  const errors: { groupId: string; value: boolean; message: string }[] = []
  const settled: string[][] = []
  const notify = vi.fn()
  const c = new GroupChipsController({
    leadId: LEAD,
    memberOf,
    onError: (e) => errors.push({ groupId: e.groupId, value: e.value, message: e.message }),
    onSettled: (m) => settled.push(m),
    notify,
    ...extra,
  })
  return { c, errors, settled, notify }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the chips' requests (stubbed fetch)", () => {
  it('toggle on → PUT /api/core-data/groups/<group>/members/<lead>; lit before the answer', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const calls = stubFetch(async () => {
      await gate
      return { status: 200, body: { changed: true } }
    })
    const { c, settled, notify } = controller([])
    c.toggle('grp_hot')
    expect(isOn(c.getState(), 'grp_hot')).toBe(true) // instant, before the CRM answers
    release()
    await c.idle()
    expect(calls).toEqual([{ method: 'PUT', url: `/api/core-data/groups/grp_hot/members/${LEAD}`, body: undefined }])
    expect(c.getState().confirmed).toEqual(['grp_hot'])
    expect(settled).toEqual([['grp_hot']])
    expect(notify).toHaveBeenCalledTimes(1) // sidebar counts move
  })

  it('toggle off → DELETE /api/core-data/groups/<group>/members/<lead>', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { changed: true } }))
    const { c, settled } = controller(['grp_hot', 'grp_nurture'])
    c.toggle('grp_nurture')
    expect(isOn(c.getState(), 'grp_nurture')).toBe(false)
    await c.idle()
    expect(calls).toEqual([{ method: 'DELETE', url: `/api/core-data/groups/grp_nurture/members/${LEAD}`, body: undefined }])
    expect(settled).toEqual([['grp_hot']])
  })

  it('an error rolls the chip back and reports the API’s plain-English message', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'Group not found.' } }))
    const { c, errors, settled, notify } = controller([])
    c.toggle('grp_gone')
    expect(isOn(c.getState(), 'grp_gone')).toBe(true)
    await c.idle()
    expect(isOn(c.getState(), 'grp_gone')).toBe(false)
    expect(errors).toEqual([{ groupId: 'grp_gone', value: true, message: 'Group not found.' }])
    expect(settled).toEqual([]) // nothing changed
    expect(notify).not.toHaveBeenCalled()
  })

  it('a network failure says so in plain English', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const { c, errors } = controller(['grp_hot'])
    c.toggle('grp_hot')
    await c.idle()
    expect(isOn(c.getState(), 'grp_hot')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe("Couldn't reach the CRM. Check your connection and try again.")
  })

  it('fast clicks on one chip: one request at a time, ending on the last wish', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const calls = stubFetch(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { status: 200, body: { changed: true } }
    })
    const { c, settled } = controller([])
    c.toggle('grp_hot') // on (sent at once)
    c.toggle('grp_hot') // off (waits)
    c.toggle('grp_hot') // on again (still waits; the add in flight already does it)
    await c.idle()
    expect(maxInFlight).toBe(1)
    expect(calls.map((x) => x.method)).toEqual(['PUT'])
    expect(isOn(c.getState(), 'grp_hot')).toBe(true)
    expect(settled).toEqual([['grp_hot']])
  })

  it('clicks on two chips go out together, and the page hears about it once', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { changed: true } }))
    const { c, settled, notify } = controller(['grp_a'])
    c.toggle('grp_a')
    c.toggle('grp_b')
    await c.idle()
    expect(calls.map((x) => `${x.method} ${x.url}`).sort()).toEqual([
      `DELETE /api/core-data/groups/grp_a/members/${LEAD}`,
      `PUT /api/core-data/groups/grp_b/members/${LEAD}`,
    ])
    expect(settled).toEqual([['grp_b']])
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('"+" creates the group and adds the lead in one request: POST /api/core-data/groups { name, leadId }', async () => {
    const calls = stubFetch(() => ({
      status: 201,
      body: { group: { id: 'grp_new', name: 'Callbacks', color: 'gray', sortOrder: 3, memberCount: 1 }, added: 1 },
    }))
    const { c, settled, notify } = controller(['grp_hot'])
    const group = await c.createAndAdd('  Callbacks ')
    expect(group).toEqual({ id: 'grp_new', name: 'Callbacks', color: 'gray', sortOrder: 3, memberCount: 1 })
    expect(calls).toEqual([{ method: 'POST', url: '/api/core-data/groups', body: { name: 'Callbacks', leadId: LEAD } }])
    expect(isOn(c.getState(), 'grp_new')).toBe(true)
    expect(isOn(c.getState(), 'grp_hot')).toBe(true)
    expect(settled).toEqual([['grp_hot', 'grp_new']])
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('"+" with a name already taken: the API’s 409 message comes back for the inline error, nothing lights up', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'A group named "Hot" already exists.' } }))
    const { c, settled, notify } = controller([])
    await expect(c.createAndAdd('hot')).rejects.toThrow('A group named "Hot" already exists.')
    expect(c.getState().confirmed).toEqual([])
    expect(settled).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('"+" with an empty name never reaches the CRM', async () => {
    const calls = stubFetch(() => ({ status: 500, body: {} }))
    const { c } = controller([])
    await expect(c.createAndAdd('   ')).rejects.toThrow('Name must be 1–60 characters.')
    expect(calls).toEqual([])
  })
})
