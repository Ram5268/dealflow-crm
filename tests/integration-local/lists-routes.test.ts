import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { GET as sidebarGET } from '@/app/api/core-data/sidebar/route'
import { POST as foldersPOST } from '@/app/api/core-data/folders/route'
import { PATCH as folderPATCH, DELETE as folderDELETE } from '@/app/api/core-data/folders/[id]/route'
import { POST as foldersReorderPOST } from '@/app/api/core-data/folders/reorder/route'
import { GET as listsGET, POST as listsPOST } from '@/app/api/core-data/lists/route'
import { PATCH as listPATCH, DELETE as listDELETE } from '@/app/api/core-data/lists/[id]/route'
import { POST as listsReorderPOST } from '@/app/api/core-data/lists/reorder/route'
import { GET as membersGET, POST as membersPOST, DELETE as membersDELETE } from '@/app/api/core-data/lists/[id]/members/route'
import { GET as listExportGET } from '@/app/api/core-data/lists/[id]/export/route'
import { GET as allLeadsGET } from '@/app/api/core-data/all-leads/route'
import { GET as allLeadsExportGET } from '@/app/api/core-data/all-leads/export/route'
import { GET as groupsGET, POST as groupsPOST } from '@/app/api/core-data/groups/route'
import { PATCH as groupPATCH, DELETE as groupDELETE } from '@/app/api/core-data/groups/[id]/route'
import { POST as groupsReorderPOST } from '@/app/api/core-data/groups/reorder/route'
import { POST as groupsMovePOST } from '@/app/api/core-data/groups/move/route'
import { POST as groupMembersPOST, DELETE as groupMembersDELETE } from '@/app/api/core-data/groups/[id]/members/route'
import { PUT as groupMemberPUT, DELETE as groupMemberDELETE } from '@/app/api/core-data/groups/[id]/members/[leadId]/route'
import { GET as leadMembershipsGET } from '@/app/api/core-data/leads/[id]/memberships/route'
import { GET as pipelineGET } from '@/app/api/core-data/pipeline/route'
import { GET as workflowsGET, POST as workflowsPOST } from '@/app/api/core-data/workflows/route'
import { PATCH as workflowPATCH, DELETE as workflowDELETE } from '@/app/api/core-data/workflows/[id]/route'
import { GET as smartViewsGET, POST as smartViewsPOST } from '@/app/api/smart-views/route'
import { GET as smartViewGET, PUT as smartViewPUT, DELETE as smartViewDELETE } from '@/app/api/smart-views/[id]/route'
import { getQueue } from '@/lib/core-data/smart-view/queue-service'
import { getReviewList } from '@/lib/core-data/smart-view/review-list'
import { getDialQueue } from '@/lib/focus/summary'

// Brief 45 PR A — the HTTP routes under /api/core-data (status codes, the
// plain-English error text every screen shows, org scoping), plus every
// existing SavedView reader, which must never treat a Pipeline workflow
// (type 'pipeline') as a lead Smart View. Made-up leads only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45_${Date.now()}`

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>

async function call(handler: Handler, method: string, url: string, opts: { body?: unknown; params?: Record<string, string> } = {}) {
  const req = new NextRequest(new URL(url, 'http://localhost'), {
    method,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } } : {}),
  })
  const res = await handler(req, opts.params ? { params: Promise.resolve(opts.params) } : undefined)
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() }
}

describe.runIf(enabled)('Brief 45 routes (/api/core-data)', () => {
  let orgId: string
  let otherOrg: string
  const leads: string[] = []
  let foreign: { folder: string; list: string; group: string; lead: string }

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    for (let i = 0; i < 3; i++) {
      leads.push((await prisma.lead.create({ data: { organizationId: orgId, displayName: `${TAG} owner ${i}`, source: TAG, priorityScore: 50 - i } })).id)
    }
    otherOrg = (await prisma.organization.create({ data: { slug: `${TAG}_other`.toLowerCase(), name: 'Brief 45 other org' } })).id
    const lead = (await prisma.lead.create({ data: { organizationId: otherOrg, displayName: `${TAG} other owner`, source: TAG } })).id
    foreign = {
      folder: (await prisma.folder.create({ data: { organizationId: otherOrg, name: 'Theirs' } })).id,
      list: (await prisma.callList.create({ data: { organizationId: otherOrg, name: 'Theirs', memberships: { create: { leadId: lead, addedBy: 'manual' } } } })).id,
      group: (await prisma.leadGroup.create({ data: { organizationId: otherOrg, name: 'Theirs' } })).id,
      lead,
    }
  })

  afterAll(async () => {
    const mine = { organizationId: orgId, name: { startsWith: TAG } }
    await prisma.activity.deleteMany({ where: { leadId: { in: [...leads, foreign.lead] } } })
    await prisma.callList.deleteMany({ where: mine })
    await prisma.folder.deleteMany({ where: mine })
    await prisma.leadGroup.deleteMany({ where: mine })
    await prisma.savedView.deleteMany({ where: mine })
    await prisma.lead.deleteMany({ where: { source: TAG } })
    await prisma.callList.deleteMany({ where: { organizationId: otherOrg } })
    await prisma.folder.deleteMany({ where: { organizationId: otherOrg } })
    await prisma.leadGroup.deleteMany({ where: { organizationId: otherOrg } })
    await prisma.lead.deleteMany({ where: { organizationId: otherOrg } })
    await prisma.organization.delete({ where: { id: otherOrg } })
  })

  it('folders: create, duplicate, no nesting, rename, reorder, delete only when empty, org scoping', async () => {
    const created = await call(foldersPOST, 'POST', '/api/core-data/folders', { body: { name: `${TAG} Expireds` } })
    expect(created.status).toBe(201)
    const folder = created.body.folder
    expect(folder).toMatchObject({ name: `${TAG} Expireds`, listCount: 0 })

    const dup = await call(foldersPOST, 'POST', '/api/core-data/folders', { body: { name: ` ${TAG} EXPIREDS ` } })
    expect(dup).toMatchObject({ status: 409, body: { error: `A folder named "${TAG} Expireds" already exists.` } })

    // There is no parent field, and the API refuses any attempt to pass one [Ryan 2026-10-18].
    for (const body of [{ name: `${TAG} Nested`, parentId: folder.id }, { name: `${TAG} Nested`, folderId: folder.id }]) {
      const nested = await call(foldersPOST, 'POST', '/api/core-data/folders', { body })
      expect(nested.status).toBe(400)
      expect(nested.body.error).toMatch(/folder/i)
    }
    const nestedPatch = await call(folderPATCH, 'PATCH', `/api/core-data/folders/${folder.id}`, { body: { parentId: folder.id }, params: { id: folder.id } })
    expect(nestedPatch.status).toBe(400)

    const renamed = await call(folderPATCH, 'PATCH', `/api/core-data/folders/${folder.id}`, { body: { name: `${TAG} Expired listings` }, params: { id: folder.id } })
    expect(renamed).toMatchObject({ status: 200, body: { folder: { name: `${TAG} Expired listings` } } })
    expect((await call(folderPATCH, 'PATCH', '/x', { body: { name: `${TAG} x` }, params: { id: foreign.folder } })).status).toBe(404)
    expect((await call(folderDELETE, 'DELETE', '/x', { params: { id: foreign.folder } })).status).toBe(404)

    const list = await call(listsPOST, 'POST', '/api/core-data/lists', { body: { name: `${TAG} Oct`, folderId: folder.id } })
    expect(list.status).toBe(201)
    const blocked = await call(folderDELETE, 'DELETE', '/x', { params: { id: folder.id } })
    expect(blocked).toMatchObject({ status: 409, body: { error: 'This folder still has 1 list. Move or delete it first.' } })
    expect((await call(listDELETE, 'DELETE', '/x', { params: { id: list.body.list.id } })).body).toEqual({ deleted: true, membershipsRemoved: 0 })

    const sidebar = await call(sidebarGET, 'GET', '/api/core-data/sidebar')
    const ids = sidebar.body.folders.map((f: { id: string }) => f.id)
    const reordered = await call(foldersReorderPOST, 'POST', '/x', { body: { ids: [...ids].reverse() } })
    expect(reordered).toMatchObject({ status: 200, body: { ok: true } })
    expect((await call(foldersReorderPOST, 'POST', '/x', { body: { ids: ids.slice(1) } })).status).toBe(409)

    expect((await call(folderDELETE, 'DELETE', '/x', { params: { id: folder.id } })).body).toEqual({ deleted: true })
  })

  it('lists: create with members, update, archive, members, ids, export, reorder, 5,001 → 400', async () => {
    const created = await call(listsPOST, 'POST', '/x', { body: { name: `${TAG} Referrals`, folderId: null, leadIds: [leads[0], leads[1], foreign.lead] } })
    expect(created).toMatchObject({ status: 201, body: { added: 2, list: { folderId: null, memberCount: 2, source: 'manual' } } })
    const id = created.body.list.id
    expect((await call(listsPOST, 'POST', '/x', { body: { name: `${TAG} REFERRALS` } })).body.error).toBe(`A list named "${TAG} Referrals" is already outside folders.`)
    expect((await call(listsPOST, 'POST', '/x', { body: { name: '' } })).body.error).toBe('Name must be 1–60 characters.')

    const added = await call(membersPOST, 'POST', '/x', { body: { leadIds: [leads[1], leads[2], 'nope'] }, params: { id } })
    expect(added.body).toEqual({ added: 1, alreadyIn: 1, notFound: 1 })
    const tooMany = await call(membersPOST, 'POST', '/x', { body: { leadIds: Array.from({ length: 5_001 }, (_, i) => `x${i}`) }, params: { id } })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error).toMatch(/5,000/)

    const page = await call(membersGET, 'GET', `/api/core-data/lists/${id}/members?page=1`, { params: { id } })
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({ total: 3, memberCount: 3, page: 1, pageSize: 100, list: { id, name: `${TAG} Referrals`, folderName: null } })
    expect(page.body.rows.map((r: { leadId: string }) => r.leadId)).toEqual(leads)
    expect(page.body.rows.map((r: { rank: number }) => r.rank)).toEqual([1, 2, 3])
    expect(page.body.callingOffReason).toBe(process.env.DIALING_ENABLED === 'true' ? null : 'Calling is off')
    const searched = await call(membersGET, 'GET', `/x?q=${encodeURIComponent(`${TAG} owner 2`)}`, { params: { id } })
    expect(searched.body.rows.map((r: { rank: number }) => r.rank)).toEqual([3])
    const idsOnly = await call(membersGET, 'GET', '/x?ids=1', { params: { id } })
    expect(idsOnly.body).toEqual({ ids: leads })
    expect((await call(membersGET, 'GET', '/x?borough=Jersey', { params: { id } })).status).toBe(400)
    expect((await call(membersGET, 'GET', '/x', { params: { id: foreign.list } })).status).toBe(404)

    const csv = await call(listExportGET, 'GET', '/x', { params: { id } })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toMatch(/^text\/csv/)
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment; filename=".+\.csv"$/)
    expect((csv.body as string).split('\n')[0]).toBe('Rank,Name,Address,Priority,Match fit,Why now,Best buyer,Groups,Attempts,Last result,Timezone')

    const removed = await call(membersDELETE, 'DELETE', '/x', { body: { leadIds: [leads[2], leads[2]] }, params: { id } })
    expect(removed.body).toEqual({ removed: 1 })

    const archived = await call(listPATCH, 'PATCH', '/x', { body: { archived: true }, params: { id } })
    expect(archived.body.list.archivedAt).not.toBeNull()
    const active = await call(listsGET, 'GET', '/api/core-data/lists')
    expect(active.body.lists.map((l: { id: string }) => l.id)).not.toContain(id)
    const arch = await call(listsGET, 'GET', '/api/core-data/lists?archived=1')
    expect(arch.body.lists.map((l: { id: string }) => l.id)).toContain(id)
    await call(listPATCH, 'PATCH', '/x', { body: { archived: false }, params: { id } })
    expect((await call(listPATCH, 'PATCH', '/x', { body: { folderId: foreign.folder }, params: { id } })).status).toBe(404)
    expect((await call(listPATCH, 'PATCH', '/x', { body: { name: `${TAG} x` }, params: { id: foreign.list } })).status).toBe(404)

    const loose = (await call(listsGET, 'GET', '/x')).body.lists.filter((l: { folderId: string | null }) => l.folderId === null).map((l: { id: string }) => l.id)
    expect((await call(listsReorderPOST, 'POST', '/x', { body: { folderId: null, ids: [...loose].reverse() } })).body).toEqual({ ok: true })

    expect((await call(listDELETE, 'DELETE', '/x', { params: { id } })).body).toEqual({ deleted: true, membershipsRemoved: 2 })
    expect(await prisma.lead.count({ where: { id: { in: leads } } })).toBe(3) // never deletes a lead
  })

  it('all leads: ranked page and export', async () => {
    const page = await call(allLeadsGET, 'GET', '/api/core-data/all-leads?q=' + encodeURIComponent(TAG))
    expect(page.status).toBe(200)
    expect(page.body.list).toBeNull()
    expect(page.body.rows.map((r: { leadId: string }) => r.leadId)).toEqual(leads)
    const csv = await call(allLeadsExportGET, 'GET', '/x?q=' + encodeURIComponent(TAG))
    expect((csv.body as string).split('\n')).toHaveLength(4)
  })

  it('groups: create (+ chip), toggle, bulk, move, reorder, rename, delete; lead memberships', async () => {
    const hot = await call(groupsPOST, 'POST', '/x', { body: { name: `${TAG} Hot`, color: 'red', leadId: leads[0] } })
    expect(hot).toMatchObject({ status: 201, body: { added: 1, group: { name: `${TAG} Hot`, color: 'red', memberCount: 1 } } })
    const nurture = await call(groupsPOST, 'POST', '/x', { body: { name: `${TAG} Nurture` } })
    const h = hot.body.group.id
    const n = nurture.body.group.id
    expect((await call(groupsPOST, 'POST', '/x', { body: { name: `${TAG} hot` } })).body.error).toBe(`A group named "${TAG} Hot" already exists.`)
    expect((await call(groupsPOST, 'POST', '/x', { body: { name: `${TAG} Bad`, color: 'mauve' } })).status).toBe(400)
    expect((await call(groupsPOST, 'POST', '/x', { body: { name: `${TAG} Ghost`, leadId: foreign.lead } })).status).toBe(404)

    expect((await call(groupMemberPUT, 'PUT', '/x', { params: { id: n, leadId: leads[1] } })).body).toEqual({ changed: true })
    expect((await call(groupMemberPUT, 'PUT', '/x', { params: { id: n, leadId: leads[1] } })).body).toEqual({ changed: false })
    expect((await call(groupMemberPUT, 'PUT', '/x', { params: { id: n, leadId: foreign.lead } })).status).toBe(404)
    expect((await call(groupMemberPUT, 'PUT', '/x', { params: { id: foreign.group, leadId: leads[1] } })).status).toBe(404)
    expect((await call(groupMemberDELETE, 'DELETE', '/x', { params: { id: n, leadId: leads[1] } })).body).toEqual({ changed: true })
    expect((await call(groupMemberDELETE, 'DELETE', '/x', { params: { id: n, leadId: leads[1] } })).body).toEqual({ changed: false })

    expect((await call(groupMembersPOST, 'POST', '/x', { body: { leadIds: [...leads, foreign.lead] }, params: { id: n } })).body).toEqual({ added: 3, alreadyIn: 0, notFound: 1 })
    expect((await call(groupMembersDELETE, 'DELETE', '/x', { body: { leadIds: [leads[2]] }, params: { id: n } })).body).toEqual({ removed: 1 })

    const moved = await call(groupsMovePOST, 'POST', '/x', { body: { leadId: leads[1], fromGroupId: n, toGroupId: h } })
    expect(moved).toMatchObject({ status: 200, body: { ok: true } })
    const m = await call(leadMembershipsGET, 'GET', '/x', { params: { id: leads[1] } })
    expect(m.body.groupIds).toEqual([h])
    expect((await call(leadMembershipsGET, 'GET', '/x', { params: { id: foreign.lead } })).status).toBe(404)
    const timeline = await prisma.activity.findMany({ where: { leadId: leads[1], type: 'Group' } })
    expect(timeline.map((a) => a.bodyText).sort()).toEqual([`Added to ${TAG} Hot`, `Added to ${TAG} Nurture`, `Added to ${TAG} Nurture`, `Removed from ${TAG} Nurture`, `Removed from ${TAG} Nurture`].sort())

    const all = (await call(groupsGET, 'GET', '/api/core-data/groups')).body.groups.map((g: { id: string }) => g.id)
    expect((await call(groupsReorderPOST, 'POST', '/x', { body: { ids: [...all].reverse() } })).body).toEqual({ ok: true })
    expect((await call(groupPATCH, 'PATCH', '/x', { body: { name: `${TAG} Very hot`, color: 'orange' }, params: { id: h } })).body.group).toMatchObject({ name: `${TAG} Very hot`, color: 'orange' })
    expect((await call(groupPATCH, 'PATCH', '/x', { body: { name: `${TAG} x` }, params: { id: foreign.group } })).status).toBe(404)
    expect((await call(groupDELETE, 'DELETE', '/x', { params: { id: h } })).body).toEqual({ deleted: true, membershipsRemoved: 2 })
    expect((await call(groupDELETE, 'DELETE', '/x', { params: { id: h } })).status).toBe(404)
    expect(await prisma.lead.count({ where: { id: { in: leads } } })).toBe(3)
  })

  it('pipeline and workflows', async () => {
    const g = (await call(groupsPOST, 'POST', '/x', { body: { name: `${TAG} Pipeline`, leadId: leads[2] } })).body.group.id
    const t = await call(pipelineGET, 'GET', `/api/core-data/pipeline?view=table&groups=${g}`)
    expect(t).toMatchObject({ status: 200, body: { view: 'table', total: 1, pageSize: 100 } })
    expect(t.body.rows[0].leadId).toBe(leads[2])
    const b = await call(pipelineGET, 'GET', `/api/core-data/pipeline?groups=${g}`)
    expect(b.body.columns.map((c: { count: number }) => c.count)).toEqual([1])
    expect((await call(pipelineGET, 'GET', '/x?tier=scorching')).status).toBe(400)

    const wf = await call(workflowsPOST, 'POST', '/x', { body: { name: `${TAG} Brownstone nurtures`, view: 'board', filters: { borough: 'Brooklyn' }, groupIds: [g] } })
    expect(wf).toMatchObject({ status: 201, body: { workflow: { name: `${TAG} Brownstone nurtures`, groupIds: [g], sort: null } } })
    const id = wf.body.workflow.id
    expect((await call(workflowsPOST, 'POST', '/x', { body: { name: `${TAG} brownstone NURTURES`, view: 'board', filters: {}, groupIds: [] } })).status).toBe(409)
    expect((await call(workflowsGET, 'GET', '/x')).body.workflows.map((w: { id: string }) => w.id)).toContain(id)
    expect((await call(workflowPATCH, 'PATCH', '/x', { body: { view: 'table' }, params: { id } })).body.workflow.view).toBe('table')
    expect((await call(workflowDELETE, 'DELETE', '/x', { params: { id } })).body).toEqual({ deleted: true })
    expect((await call(workflowDELETE, 'DELETE', '/x', { params: { id } })).status).toBe(404)
  })

  describe('existing SavedView readers never treat a workflow as a lead Smart View', () => {
    let workflowId: string
    let leadViewId: string

    beforeAll(async () => {
      leadViewId = (await prisma.savedView.create({ data: { organizationId: orgId, name: `${TAG} lead view`, type: 'lead', sQuery: { type: 'match_all' } } })).id
      // Created last, so it is the newest SavedView of the org.
      workflowId = (await call(workflowsPOST, 'POST', '/x', { body: { name: `${TAG} Workflow`, view: 'board', filters: {}, groupIds: [] } })).body.workflow.id
    })

    it('/api/smart-views hides workflows and refuses to read, edit, delete or create one', async () => {
      const list = await call(smartViewsGET, 'GET', '/api/smart-views')
      const ids = list.body.views.map((v: { id: string }) => v.id)
      expect(ids).toContain(leadViewId)
      expect(ids).not.toContain(workflowId)
      expect((await call(smartViewGET, 'GET', '/x', { params: { id: workflowId } })).status).toBe(404)
      const put = await call(smartViewPUT, 'PUT', '/x', { body: { sQuery: { type: 'match_all' } }, params: { id: workflowId } })
      expect(put.status).toBe(404)
      expect((await call(smartViewDELETE, 'DELETE', '/x', { params: { id: workflowId } })).status).toBe(404)
      expect(await prisma.savedView.findUnique({ where: { id: workflowId } })).toMatchObject({ type: 'pipeline' }) // untouched
      const create = await call(smartViewsPOST, 'POST', '/x', { body: { name: `${TAG} sneaky`, type: 'pipeline', sQuery: { type: 'match_all' } } })
      expect(create.status).toBe(400)
      expect(await prisma.savedView.count({ where: { organizationId: orgId, name: `${TAG} sneaky` } })).toBe(0)
    })

    it('/queue (dial queue and review list) and Focus refuse or skip a workflow', async () => {
      await expect(getQueue(workflowId, orgId)).rejects.toMatchObject({ status: 400 })
      await expect(getReviewList(workflowId, orgId)).rejects.toMatchObject({ status: 400 })
      const focus = await getDialQueue(orgId)
      if ('viewId' in focus) expect(focus.viewId).not.toBe(workflowId)
      expect(focus.kind).not.toBe('no-view') // the lead view exists, so Focus found a lead view
    })
  })
})
