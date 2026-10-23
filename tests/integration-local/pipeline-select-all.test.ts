import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { GET as pipelineGET } from '@/app/api/core-data/pipeline/route'

// Brief 50 PR 7 (open item 6.12): GET /api/core-data/pipeline?…&ids=1 answers
// { ids } (everyone the Pipeline table shows for those groups, filters and
// sort) for the table's "Select all N matching", like the list pages' and All
// leads' ids=1. Made-up data only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B50P7_${Date.now()}`

async function get(query: string) {
  const res = await pipelineGET(new NextRequest(new URL(`/api/core-data/pipeline?${query}`, 'http://localhost')))
  return { status: res.status, body: await res.json() }
}

describe.runIf(enabled)('GET /api/core-data/pipeline?ids=1', () => {
  let groupId: string
  const leadIds: string[] = []

  beforeAll(async () => {
    const orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    for (const [i, score] of [40, 90, 70].entries()) {
      leadIds.push((await prisma.lead.create({ data: { organizationId: orgId, displayName: `${TAG} owner ${i}`, priorityScore: score, source: TAG } })).id)
    }
    groupId = (await prisma.leadGroup.create({
      data: { organizationId: orgId, name: `${TAG} Hot`, memberships: { create: leadIds.map((leadId) => ({ leadId, addedBy: 'manual' })) } },
    })).id
  })

  afterAll(async () => {
    if (groupId) await prisma.leadGroup.delete({ where: { id: groupId } })
    await prisma.lead.deleteMany({ where: { source: TAG } })
  })

  it('every matching id, in the table order (rank: highest priority first)', async () => {
    const r = await get(`view=table&groups=${groupId}&ids=1`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ids: [leadIds[1], leadIds[2], leadIds[0]] })
  })

  it('with the filters and sort of the table, whatever page is open', async () => {
    const r = await get(`view=table&groups=${groupId}&q=${encodeURIComponent(`${TAG} owner 2`)}&sort=name&dir=desc&page=3&ids=1`)
    expect(r.body).toEqual({ ids: [leadIds[2]] })
  })

  it('without ids=1 the table itself, as before', async () => {
    const r = await get(`view=table&groups=${groupId}`)
    expect(r.body).toMatchObject({ view: 'table', total: 3 })
  })
})
