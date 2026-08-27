import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { POST as searchRoute } from '@/app/api/data/search/route'
import { emit } from '@/lib/core-data/events/emit'
import { NOTIFY_SAFE_BYTES } from '@/lib/core-data/events/emit'

const enabled = !!process.env.DATABASE_URL_MAIN
const MARK = 'TEST_SE'
let orgId: string

function req(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/data/search', 'http://localhost'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe.runIf(enabled)('/api/data/search + executor', () => {
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id
    await prisma.lead.deleteMany({ where: { source: MARK } })
    await prisma.lead.createMany({
      data: [
        { organizationId: orgId, displayName: 'SE A', source: MARK, priorityScore: 90 },
        { organizationId: orgId, displayName: 'SE B', source: MARK, priorityScore: 50 },
        { organizationId: orgId, displayName: 'SE C', source: MARK, priorityScore: 10 },
      ],
    })
  })
  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { source: MARK } })
  })

  it('executes an s_query with pagination + includeCount (execute + executeCount)', async () => {
    const sQuery = {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'source' },
      condition: { type: 'text', mode: 'exact', value: MARK },
    }
    const res = await searchRoute(req({ sQuery, limit: 2, includeCount: true }))
    const body = await res.json()
    expect(body.results).toHaveLength(2)
    expect(body.totalCount).toBe(3)
    expect(body.nextCursor).toBeTruthy()

    // Page 2 via cursor.
    const res2 = await searchRoute(req({ sQuery, limit: 2, cursor: body.nextCursor }))
    const body2 = await res2.json()
    expect(body2.results).toHaveLength(1)
    expect(body2.nextCursor).toBeNull()
  })
})

describe.runIf(enabled)('emit() default path', () => {
  afterAll(async () => {
    await prisma.notifyOverflow.deleteMany({ where: { channel: 'test_emit' } })
  })

  it('small payload → pg_notify, no overflow', async () => {
    const r = await emit('test_emit', { hello: 'world', correlationId: 'c1' })
    expect(r.overflow).toBe(false)
    expect(r.bytes).toBeGreaterThan(0)
  })

  it('oversized payload → NotifyOverflow row written', async () => {
    const r = await emit('test_emit', { blob: 'x'.repeat(NOTIFY_SAFE_BYTES + 50), correlationId: 'c2' })
    expect(r.overflow).toBe(true)
    expect(r.overflowId).toBeTruthy()
    const row = await prisma.notifyOverflow.findUnique({ where: { id: r.overflowId! } })
    expect(row).toBeTruthy()
  })
})
