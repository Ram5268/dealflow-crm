import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { POST as createView } from '@/app/api/smart-views/route'
import { PUT as updateView } from '@/app/api/smart-views/[id]/route'
import { POST as search } from '@/app/api/data/search/route'
import { getReviewList } from '@/lib/core-data/smart-view/review-list'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import { mainIsTestDb } from '../setup/live-guard'

// Brief 50 PR 4 (open item 6.4, audit finding L15), through the real route
// handlers on a test database: the hidden "Callable now" filter is refused
// loudly by the Smart View API and the ad-hoc search (it used to be accepted
// and silently match everyone), and "Do-not-call clean" really filters.
// Made-up people only; phones in 555-0100…0199.

const enabled = mainIsTestDb() // refuses a live DATABASE_URL_MAIN
const MARK = 'TEST_B50_PR4'
const CLEAN_PHONE = '+17185550154'
const OPTED_OUT_PHONE = '+17185550158'
const UNCHECKED_PHONE = '+17185550168'
const PHONES = [CLEAN_PHONE, OPTED_OUT_PHONE, UNCHECKED_PHONE]
const NOT_AVAILABLE = /"Callable now" filter isn't available yet/

const CALLABLE_NOW = {
  type: 'field_condition',
  field: { kind: 'compliance', predicate: 'callable_now' },
  condition: { type: 'term', op: 'in', values: ['true'] },
}
const DNC_CLEAN = {
  type: 'field_condition',
  field: { kind: 'compliance', predicate: 'dnc_clean' },
  condition: { type: 'term', op: 'in', values: ['true'] },
}
const MARKED = {
  type: 'field_condition',
  field: { kind: 'regular', table: 'lead', column: 'source' },
  condition: { type: 'text', mode: 'exact', value: MARK },
}

function req(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const issueText = (body: { issues?: { message: string }[] }) => (body.issues ?? []).map((i) => i.message).join(' ')

let orgId: string
let cleanLeadId: string

async function cleanup() {
  await prisma.savedView.deleteMany({ where: { organizationId: orgId, name: { startsWith: MARK } } })
  await prisma.lead.deleteMany({ where: { organizationId: orgId, source: MARK } })
  await prisma.scrubLog.deleteMany({ where: { organizationId: orgId, phone: { in: PHONES } } })
  await prisma.dncSuppression.deleteMany({ where: { organizationId: orgId, phone: { in: PHONES } } })
}

describe.runIf(enabled)('Smart View filters through the API (Brief 50 PR 4)', () => {
  beforeAll(async () => {
    orgId = await getCurrentOrgId()
    await cleanup()
    const person = async (name: string, phone: string) =>
      prisma.lead.create({
        data: {
          organizationId: orgId,
          displayName: `${MARK} ${name}`,
          source: MARK,
          contacts: { create: { organizationId: orgId, displayName: `Test Owner ${name}`, phones: { create: { phone, type: 'mobile' } } } },
        },
      })
    cleanLeadId = (await person('clean', CLEAN_PHONE)).id
    await person('opted out', OPTED_OUT_PHONE)
    await person('never checked', UNCHECKED_PHONE)
    for (const phone of [CLEAN_PHONE, OPTED_OUT_PHONE]) {
      await prisma.scrubLog.create({ data: { organizationId: orgId, phone, operation: 'check-federal', result: 'clean' } })
    }
    await prisma.dncSuppression.create({ data: { organizationId: orgId, phone: OPTED_OUT_PHONE, source: 'internal', addedBy: 'test' } })
  })
  afterAll(cleanup)

  it('POST /api/smart-views refuses a view using "Callable now" (400, plain message) and saves nothing', async () => {
    const res = await createView(req('/api/smart-views', 'POST', { name: `${MARK} callable`, sQuery: { type: 'and', queries: [MARKED, CALLABLE_NOW] } }))
    expect(res.status).toBe(400)
    expect(issueText(await res.json())).toMatch(NOT_AVAILABLE)
    expect(await prisma.savedView.count({ where: { organizationId: orgId, name: `${MARK} callable` } })).toBe(0)
  })

  it('PUT /api/smart-views/[id] refuses to switch a view to "Callable now" and leaves it unchanged', async () => {
    const created = await createView(req('/api/smart-views', 'POST', { name: `${MARK} clean`, sQuery: DNC_CLEAN }))
    expect(created.status).toBe(201)
    const { view } = await created.json()
    const res = await updateView(req(`/api/smart-views/${view.id}`, 'PUT', { sQuery: CALLABLE_NOW }), { params: Promise.resolve({ id: view.id }) })
    expect(res.status).toBe(400)
    expect(issueText(await res.json())).toMatch(NOT_AVAILABLE)
    const stored = await prisma.savedView.findUniqueOrThrow({ where: { id: view.id } })
    expect(stored.sQuery).toEqual(DNC_CLEAN)
  })

  it('POST /api/data/search refuses "Callable now" instead of returning everyone', async () => {
    const res = await search(req('/api/data/search', 'POST', { sQuery: { type: 'and', queries: [MARKED, CALLABLE_NOW] }, includeCount: true }))
    expect(res.status).toBe(400)
    expect(issueText(await res.json())).toMatch(NOT_AVAILABLE)
  })

  it('POST /api/data/search with "Do-not-call clean" returns only the clean person', async () => {
    const res = await search(req('/api/data/search', 'POST', { sQuery: { type: 'and', queries: [MARKED, DNC_CLEAN] }, includeCount: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalCount).toBe(1)
    expect(body.results.map((r: { id: string }) => r.id)).toEqual([cleanLeadId])
  })

  it('the /queue review list says a saved "Callable now" view isn\'t available (it used to run as if the filter weren\'t there)', async () => {
    // Saved straight to the database: a view stored before the filter was hidden.
    const view = await prisma.savedView.create({
      data: { organizationId: orgId, name: `${MARK} old callable`, type: 'lead', sQuery: { type: 'and', queries: [MARKED, CALLABLE_NOW] } },
    })
    await expect(getReviewList(view.id, orgId)).rejects.toThrow(NOT_AVAILABLE)
  })
})
