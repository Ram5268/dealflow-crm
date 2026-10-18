import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { POST as groupsPOST } from '@/app/api/core-data/groups/route'
import { DELETE as groupDELETE } from '@/app/api/core-data/groups/[id]/route'
import { POST as groupMembersPOST, DELETE as groupMembersDELETE } from '@/app/api/core-data/groups/[id]/members/route'
import { PUT as groupMemberPUT, DELETE as groupMemberDELETE } from '@/app/api/core-data/groups/[id]/members/[leadId]/route'
import { POST as listsPOST } from '@/app/api/core-data/lists/route'
import { POST as listMembersPOST, DELETE as listMembersDELETE } from '@/app/api/core-data/lists/[id]/members/route'
import { GET as allLeadsGET } from '@/app/api/core-data/all-leads/route'
import { GroupChipsController } from '@/components/lists/group-chips-state'
import { runBulk } from '@/components/lists/bulk-actions'
import { getAllLeadIds } from '@/lib/core-data/lists/client'

// Brief 45 PR C — the chips' and bulk actions' requests, end to end through
// PR A's real route handlers and a test database (no server): `fetch` is
// routed in-process to the handlers. Proves each click and each bulk run
// leaves the right memberships and timeline entries ("Added to X" /
// "Removed from X", Activity type Group), and that a 5,001-person selection is
// sent in two requests under the API's 5,000 cap. Made-up leads only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45C_${Date.now()}`
const BULK_TAG = `${TAG}_bulk`

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>
const ROUTES: [string, RegExp, Handler, string[]][] = [
  ['PUT', /^\/api\/core-data\/groups\/([^/]+)\/members\/([^/]+)$/, groupMemberPUT as Handler, ['id', 'leadId']],
  ['DELETE', /^\/api\/core-data\/groups\/([^/]+)\/members\/([^/]+)$/, groupMemberDELETE as Handler, ['id', 'leadId']],
  ['POST', /^\/api\/core-data\/groups\/([^/]+)\/members$/, groupMembersPOST as Handler, ['id']],
  ['DELETE', /^\/api\/core-data\/groups\/([^/]+)\/members$/, groupMembersDELETE as Handler, ['id']],
  ['POST', /^\/api\/core-data\/groups$/, groupsPOST as Handler, []],
  ['POST', /^\/api\/core-data\/lists$/, listsPOST as Handler, []],
  ['POST', /^\/api\/core-data\/lists\/([^/]+)\/members$/, listMembersPOST as Handler, ['id']],
  ['DELETE', /^\/api\/core-data\/lists\/([^/]+)\/members$/, listMembersDELETE as Handler, ['id']],
  ['GET', /^\/api\/core-data\/all-leads$/, allLeadsGET as Handler, []],
]

const seen: string[] = []

async function routedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'http://localhost')
  const method = init.method ?? 'GET'
  seen.push(`${method} ${url.pathname}`)
  for (const [m, re, handler, names] of ROUTES) {
    const match = m === method ? re.exec(url.pathname) : null
    if (!match) continue
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])]))
    const req = new NextRequest(url, { method, body: init.body ?? undefined, headers: init.headers })
    return handler(req, names.length ? { params: Promise.resolve(params) } : undefined)
  }
  throw new Error(`no route for ${method} ${url.pathname}`)
}

describe.runIf(enabled)('Brief 45 PR C: group chips and bulk actions against the real routes', () => {
  let orgId: string
  const leads: string[] = []

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    for (let i = 0; i < 3; i++) {
      leads.push((await prisma.lead.create({ data: { organizationId: orgId, displayName: `${TAG} owner ${i}`, source: TAG } })).id)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    seen.length = 0
  })

  afterAll(async () => {
    const bulk = await prisma.lead.findMany({ where: { source: BULK_TAG }, select: { id: true } })
    await prisma.activity.deleteMany({ where: { leadId: { in: [...leads, ...bulk.map((l) => l.id)] } } })
    await prisma.callList.deleteMany({ where: { organizationId: orgId, name: { startsWith: TAG } } })
    await prisma.leadGroup.deleteMany({ where: { organizationId: orgId, name: { startsWith: TAG } } })
    await prisma.lead.deleteMany({ where: { source: { in: [TAG, BULK_TAG] } } })
  })

  async function newGroup(name: string): Promise<string> {
    vi.stubGlobal('fetch', routedFetch)
    const res = await routedFetch('/api/core-data/groups', { method: 'POST', body: JSON.stringify({ name }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(201)
    return ((await res.json()) as { group: { id: string } }).group.id
  }

  const timeline = (leadId: string) =>
    prisma.activity.findMany({ where: { leadId, type: 'Group' }, orderBy: [{ activityAt: 'asc' }, { id: 'asc' }], select: { bodyText: true } })

  it('a click adds (one timeline entry); a second click removes (one more)', async () => {
    const hot = await newGroup(`${TAG} Hot`)
    vi.stubGlobal('fetch', routedFetch)
    const settled: string[][] = []
    const c = new GroupChipsController({ leadId: leads[0], memberOf: [], onSettled: (m) => settled.push(m), notify: () => {} })

    c.toggle(hot)
    await c.idle()
    expect(await prisma.leadGroupMembership.count({ where: { groupId: hot, leadId: leads[0] } })).toBe(1)
    expect(await timeline(leads[0])).toEqual([{ bodyText: `Added to ${TAG} Hot` }])

    c.toggle(hot)
    await c.idle()
    expect(await prisma.leadGroupMembership.count({ where: { groupId: hot, leadId: leads[0] } })).toBe(0)
    expect(await timeline(leads[0])).toEqual([{ bodyText: `Added to ${TAG} Hot` }, { bodyText: `Removed from ${TAG} Hot` }])
    expect(settled).toEqual([[hot], []])
    // A group click never touches list membership [Ryan, 2026-10-18].
    expect(await prisma.listMembership.count({ where: { leadId: leads[0] } })).toBe(0)
  })

  it('a quick second click: the add goes out at once, the undo follows it, and the lead ends where it started', async () => {
    const nurture = await newGroup(`${TAG} Nurture`)
    vi.stubGlobal('fetch', routedFetch)
    seen.length = 0
    const c = new GroupChipsController({ leadId: leads[1], memberOf: [], notify: () => {} })
    c.toggle(nurture)
    c.toggle(nurture)
    await c.idle()
    expect(seen).toEqual([
      `PUT /api/core-data/groups/${nurture}/members/${leads[1]}`,
      `DELETE /api/core-data/groups/${nurture}/members/${leads[1]}`,
    ])
    expect(await prisma.leadGroupMembership.count({ where: { groupId: nurture, leadId: leads[1] } })).toBe(0)
    expect((await timeline(leads[1])).map((t) => t.bodyText)).toEqual([`Added to ${TAG} Nurture`, `Removed from ${TAG} Nurture`])
    expect(c.getState().confirmed).toEqual([])
  })

  it('a group deleted somewhere else: the chip goes back and says why', async () => {
    const gone = await newGroup(`${TAG} Gone`)
    const del = await groupDELETE(new NextRequest(new URL('http://localhost/x'), { method: 'DELETE' }), { params: Promise.resolve({ id: gone }) })
    expect(del.status).toBe(200)
    vi.stubGlobal('fetch', routedFetch)
    const errors: string[] = []
    const c = new GroupChipsController({ leadId: leads[2], memberOf: [], onError: (e) => errors.push(e.message), notify: () => {} })
    c.toggle(gone)
    await c.idle()
    expect(c.getState().confirmed).toEqual([])
    expect(errors).toEqual(['Group not found.'])
    expect(await timeline(leads[2])).toEqual([])
  })

  it('"+" creates the group and adds the lead in one step', async () => {
    vi.stubGlobal('fetch', routedFetch)
    const c = new GroupChipsController({ leadId: leads[2], memberOf: [], notify: () => {} })
    const group = await c.createAndAdd(`${TAG} Callbacks`)
    expect(group.name).toBe(`${TAG} Callbacks`)
    expect(c.getState().confirmed).toEqual([group.id])
    expect(await prisma.leadGroupMembership.count({ where: { groupId: group.id, leadId: leads[2] } })).toBe(1)
    expect(await timeline(leads[2])).toEqual([{ bodyText: `Added to ${TAG} Callbacks` }])
    await expect(c.createAndAdd(`${TAG} CALLBACKS`)).rejects.toThrow(`A group named "${TAG} Callbacks" already exists.`)
  })

  it('bulk: 5,001 people (selected with "select all matching") go in two requests, and every change lands', async () => {
    await prisma.lead.createMany({
      data: Array.from({ length: 5_001 }, (_, i) => ({ organizationId: orgId, displayName: `${BULK_TAG} owner ${i}`, source: BULK_TAG })),
    })
    vi.stubGlobal('fetch', routedFetch)
    const ids = await getAllLeadIds({ q: BULK_TAG })
    expect(ids).toHaveLength(5_001)

    const appt = await newGroup(`${TAG} Appointment Set`)
    vi.stubGlobal('fetch', routedFetch)
    seen.length = 0
    const added = await runBulk({ kind: 'addToGroup', groupId: appt, name: `${TAG} Appointment Set` }, ids)
    expect(seen).toEqual([`POST /api/core-data/groups/${appt}/members`, `POST /api/core-data/groups/${appt}/members`])
    expect(added.error).toBeNull()
    expect(added.text).toBe(`Added 5,001 people to ${TAG} Appointment Set`)
    expect(await prisma.leadGroupMembership.count({ where: { groupId: appt } })).toBe(5_001)
    expect(await prisma.activity.count({ where: { type: 'Group', bodyText: `Added to ${TAG} Appointment Set` } })).toBe(5_001)

    const again = await runBulk({ kind: 'addToGroup', groupId: appt, name: `${TAG} Appointment Set` }, ids.slice(0, 10))
    expect(again.text).toBe(`All 10 were already in ${TAG} Appointment Set`)

    const made = await runBulk({ kind: 'newList', name: `${TAG} Callbacks`, folderId: null }, ids)
    expect(made.error).toBeNull()
    expect(made.text).toBe(`Made the list ${TAG} Callbacks with 5,001 people`)
    expect(await prisma.listMembership.count({ where: { listId: made.listId! } })).toBe(5_001)

    const removed = await runBulk({ kind: 'removeFromThisList', listId: made.listId!, name: `${TAG} Callbacks` }, ids)
    expect(removed.text).toBe(`Removed 5,001 people from ${TAG} Callbacks · they stay in the CRM`)
    expect(await prisma.listMembership.count({ where: { listId: made.listId! } })).toBe(0)
    expect(await prisma.lead.count({ where: { source: BULK_TAG } })).toBe(5_001) // nobody deleted
    expect(await prisma.leadGroupMembership.count({ where: { groupId: appt } })).toBe(5_001) // groups untouched

    const out = await runBulk({ kind: 'removeFromGroup', groupId: appt, name: `${TAG} Appointment Set` }, ids)
    expect(out.text).toBe(`Removed 5,001 people from ${TAG} Appointment Set`)
    expect(await prisma.leadGroupMembership.count({ where: { groupId: appt } })).toBe(0)
  })
})
