import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { GET as allLeadsGET } from '@/app/api/core-data/all-leads/route'
import { GET as membersGET } from '@/app/api/core-data/lists/[id]/members/route'
import { MAX_PAGE } from '@/lib/core-data/lists/types'

// Brief 45 PR B (found by PR D's builder): a 20-digit ?page= used to reach the
// ranked query's OFFSET and answer 500 ("bigint out of range"). A page is now
// a whole number from 1 to MAX_PAGE; anything else is page 1, never an error.
// Route handlers against the integration-local test database; made-up leads.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45_PAGES_${Date.now()}`
const HUGE = '12345678901234567890'

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>

async function get(handler: Handler, url: string, params?: Record<string, string>) {
  const res = await handler(new NextRequest(new URL(url, 'http://localhost')), params ? { params: Promise.resolve(params) } : undefined)
  return { status: res.status, body: (await res.json()) as { page: number; total: number; rows: { rank: number }[] } }
}

describe.runIf(enabled)('page numbers on the ranked routes', () => {
  let orgId: string
  let listId: string

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    const leads = []
    for (let i = 0; i < 3; i++) {
      leads.push((await prisma.lead.create({ data: { organizationId: orgId, displayName: `${TAG} owner ${i}`, source: TAG, priorityScore: 90 - i } })).id)
    }
    listId = (
      await prisma.callList.create({
        data: { organizationId: orgId, name: TAG, memberships: { create: leads.map((leadId) => ({ leadId, addedBy: 'manual' })) } },
      })
    ).id
  })

  afterAll(async () => {
    await prisma.callList.deleteMany({ where: { organizationId: orgId, name: TAG } })
    await prisma.lead.deleteMany({ where: { source: TAG } })
  })

  it('a 20-digit page on All leads is page 1, not a 500', async () => {
    const r = await get(allLeadsGET, `/api/core-data/all-leads?page=${HUGE}`)
    expect(r.status).toBe(200)
    expect(r.body.page).toBe(1)
    expect(r.body.rows[0]?.rank).toBe(1)
  })

  it("a 20-digit page on a list's members is page 1, not a 500", async () => {
    const r = await get(membersGET, `/api/core-data/lists/${listId}/members?page=${HUGE}`, { id: listId })
    expect(r.status).toBe(200)
    expect(r.body.page).toBe(1)
    expect(r.body.rows.map((x) => x.rank)).toEqual([1, 2, 3])
  })

  it('MAX_PAGE itself is accepted (past the end: no rows, the real total); one more is page 1', async () => {
    const atMax = await get(membersGET, `/api/core-data/lists/${listId}/members?page=${MAX_PAGE}`, { id: listId })
    expect(atMax.status).toBe(200)
    expect(atMax.body).toMatchObject({ page: MAX_PAGE, total: 3, rows: [] })
    const over = await get(membersGET, `/api/core-data/lists/${listId}/members?page=${MAX_PAGE + 1}`, { id: listId })
    expect(over.status).toBe(200)
    expect(over.body.page).toBe(1)
  })
})
