import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { GET as pipelineGET } from '@/app/api/core-data/pipeline/route'

// Brief 45 PR D review: a page number too big for the database (20 digits)
// made GET /api/core-data/pipeline answer 500 ("bigint out of range"). Page
// numbers are now whole numbers up to 1,000,000; anything else reads as page 1,
// like any other page value the API doesn't understand. Made-up data only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45D_${Date.now()}`

async function get(query: string) {
  const res = await pipelineGET(new NextRequest(new URL(`/api/core-data/pipeline?${query}`, 'http://localhost')))
  return { status: res.status, body: await res.json() }
}

describe.runIf(enabled)('GET /api/core-data/pipeline page numbers', () => {
  let groupId: string
  let leadId: string

  beforeAll(async () => {
    const orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    leadId = (await prisma.lead.create({ data: { organizationId: orgId, displayName: `${TAG} owner`, source: TAG } })).id
    // A group with someone in it, so the table really queries (no groups = no query at all).
    groupId = (await prisma.leadGroup.create({ data: { organizationId: orgId, name: `${TAG} Hot`, memberships: { create: { leadId, addedBy: 'manual' } } } })).id
  })

  afterAll(async () => {
    if (groupId) await prisma.leadGroup.delete({ where: { id: groupId } })
    await prisma.lead.deleteMany({ where: { source: TAG } })
  })

  it.each([
    ['20 digits', '12345678901234567890', 1],
    ['just past the limit', '1000001', 1],
    ['an unsafe integer', '9007199254740993', 1],
    ['the limit', '1000000', 1_000_000],
    ['an ordinary page', '2', 2],
  ])('page: %s (%s) → 200 and page %s', async (_label, page, expected) => {
    const r = await get(`view=table&groups=${groupId}&page=${page}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ view: 'table', page: expected })
  })

  it('page 1 still lists the person', async () => {
    const r = await get(`view=table&groups=${groupId}`)
    expect(r.body.rows.map((x: { leadId: string }) => x.leadId)).toEqual([leadId])
  })
})
