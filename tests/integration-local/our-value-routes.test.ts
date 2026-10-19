import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mainIsTestDb } from '../setup/live-guard'
import { GET as pipelineGET } from '@/app/api/core-data/pipeline/route'
import { GET as membersGET } from '@/app/api/core-data/lists/[id]/members/route'
import { GET as listExportGET } from '@/app/api/core-data/lists/[id]/export/route'
import { GET as allLeadsExportGET } from '@/app/api/core-data/all-leads/export/route'

// Brief 45 PR G — our value and range through the HTTP routes: the Pipeline's
// value filter (valueMin / valueMax, whole dollars, plain 400s), values on the
// list members API (Ryan's own screens), and never in a CSV export [Ryan,
// 2026-10-17: our value estimates never reach anything a buyer or homeowner
// sees; engineering precaution: exports can be forwarded]. Made-up data only.
const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const TAG = `TEST_B45G_${Date.now()}`

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<NextResponse>

async function get(handler: Handler, url: string, params?: Record<string, string>) {
  const res = await handler(new NextRequest(new URL(url, 'http://localhost')), params ? { params: Promise.resolve(params) } : undefined)
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() }
}

describe.runIf(enabled)('our value and range through /api/core-data', () => {
  let orgId: string
  const leads: string[] = []
  let listId: string
  let groupId: string

  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    const values: ([number, number, number] | null)[] = [[1_200_000, 1_020_000, 1_380_000], [2_400_000, 2_040_000, 2_760_000], null]
    for (const [i, value] of values.entries()) {
      const mojoId = `${TAG}_m${i}`
      const id = (await prisma.lead.create({ data: { organizationId: orgId, displayName: `${TAG} owner ${i}`, primaryAddressSummary: `${300 + i} Example St`, source: TAG, mojoId, priorityScore: 70 - i } })).id
      leads.push(id)
      if (value !== null) {
        await prisma.dealFlowDerivedSignal.create({
          data: { organizationId: orgId, mojoId, dealflowRawJson: { crmLeadId: id, property: { asOf: '2026-10-01', value: value[0], low: value[1], high: value[2], reason: null, comps: [] } } },
        })
      }
    }
    listId = (await prisma.callList.create({ data: { organizationId: orgId, name: `${TAG} list`, memberships: { create: leads.map((leadId) => ({ leadId, addedBy: 'manual' })) } } })).id
    groupId = (await prisma.leadGroup.create({ data: { organizationId: orgId, name: `${TAG} Hot`, memberships: { create: leads.map((leadId) => ({ leadId, addedBy: 'manual' })) } } })).id
  })

  afterAll(async () => {
    if (listId) await prisma.callList.delete({ where: { id: listId } })
    if (groupId) await prisma.leadGroup.delete({ where: { id: groupId } })
    await prisma.dealFlowDerivedSignal.deleteMany({ where: { mojoId: { startsWith: TAG } } })
    await prisma.lead.deleteMany({ where: { source: TAG } })
  })

  it('GET /pipeline?valueMin=&valueMax= keeps people whose value is in range (both ends), with their value', async () => {
    const r = await get(pipelineGET, `/api/core-data/pipeline?view=table&groups=${groupId}&valueMin=1200000&valueMax=2000000`)
    expect(r.status).toBe(200)
    expect(r.body.rows.map((x: { leadId: string }) => x.leadId)).toEqual([leads[0]])
    expect(r.body.rows[0].value).toEqual({ value: 1_200_000, low: 1_020_000, high: 1_380_000 })
    expect(r.body.filterOptions.hasValues).toBe(true)
    const all = await get(pipelineGET, `/api/core-data/pipeline?view=table&groups=${groupId}`)
    expect(all.body.rows.map((x: { leadId: string }) => x.leadId)).toEqual(leads)
  })

  it.each([
    ['words', 'valueMin=lots'],
    ['a negative amount', 'valueMax=-1'],
    ['cents', 'valueMin=1500000.50'],
    ['over $1,000,000,000', 'valueMax=1000000001'],
    ['backwards', 'valueMin=3000000&valueMax=2000000'],
    ['the old single parameter', 'value=1000000'],
  ])('GET /pipeline with %s → 400 in plain English', async (_label, qs) => {
    const r = await get(pipelineGET, `/api/core-data/pipeline?view=table&groups=${groupId}&${qs}`)
    expect(r.status).toBe(400)
    expect(r.body.error ?? r.body.message).toMatch(/value/i)
  })

  it('the list members API (Ryan\'s list page) carries the value; the list and All leads CSVs never do', async () => {
    const page = await get(membersGET, `/api/core-data/lists/${listId}/members`, { id: listId })
    expect(page.status).toBe(200)
    expect(page.body.rows.map((r: { value: unknown }) => r.value)).toEqual([
      { value: 1_200_000, low: 1_020_000, high: 1_380_000 },
      { value: 2_400_000, low: 2_040_000, high: 2_760_000 },
      null,
    ])
    for (const r of [await get(listExportGET, `/api/core-data/lists/${listId}/export`, { id: listId }), await get(allLeadsExportGET, `/api/core-data/all-leads/export?q=${TAG}`)]) {
      expect(r.status).toBe(200)
      expect(r.type).toContain('text/csv')
      const csv = r.body as string
      expect(csv.split('\n')[0]).toBe('Rank,Name,Address,Priority,Match fit,Why now,Best buyer,Groups,Attempts,Last result,Timezone')
      expect(csv).toContain(`${TAG} owner 0`)
      expect(csv).not.toMatch(/1200000|1020000|1380000|2400000|1\.2M|\$|likely/)
    }
  })
})
