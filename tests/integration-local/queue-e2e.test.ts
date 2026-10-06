import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/prisma'
import { getQueue } from '@/lib/core-data/smart-view/queue-service'
import type { BatchCaller } from '@/lib/core-data/query-dsl/compliance-bridge'
import type { SQuery } from '@/lib/core-data/query-dsl/schema'
import { mainIsTestDb } from '../setup/live-guard'

const enabled = mainIsTestDb() // Brief 41: refuses a live DATABASE_URL_MAIN
const MARK = 'TEST_QUEUE_E2E'

// Caller mirroring the mock: DNC phones blocked; entries with no timezone
// fail-closed as timezone_unresolved; everything else callable.
const mockCaller: BatchCaller = async (body) =>
  body.entries.map((e) => {
    const reasons: string[] = []
    if (e.timezone === undefined) reasons.push('timezone_unresolved')
    if (e.phone.includes('DNC')) reasons.push('internal_dnc')
    return { contactPhoneId: e.contactPhoneId, phone: e.phone, callable: reasons.length === 0, reasons }
  })

const throwingCaller: BatchCaller = async () => {
  throw new Error('ECONNREFUSED')
}

let orgId: string
let viewId: string
let emptyViewId: string

const sourceQuery = (marker: string): SQuery => ({
  type: 'field_condition',
  field: { kind: 'regular', table: 'lead', column: 'source' },
  condition: { type: 'text', mode: 'exact', value: marker },
})

describe.runIf(enabled)('queue e2e (getQueue)', () => {
  beforeAll(async () => {
    orgId = (await prisma.organization.findFirstOrThrow({ where: { slug: 'dealflow-ryan' } })).id

    // Clean any prior run.
    await prisma.contactPhone.deleteMany({ where: { contact: { lead: { source: MARK } } } })
    await prisma.contact.deleteMany({ where: { lead: { source: MARK } } })
    await prisma.lead.deleteMany({ where: { source: MARK } })

    // Lead A — callable (has primary phone + tz).
    const a = await prisma.lead.create({
      data: { organizationId: orgId, displayName: 'A callable', source: MARK, priorityScore: 90, timezone: 'America/New_York' },
    })
    await prisma.contact.create({
      data: {
        organizationId: orgId, leadId: a.id, displayName: 'A contact', timezone: 'America/New_York',
        phones: { create: { phone: '+12125550001', type: 'mobile', isPrimary: true } },
      },
    })

    // Lead B — no phone → excludedNoPhone.
    await prisma.lead.create({
      data: { organizationId: orgId, displayName: 'B nophone', source: MARK, priorityScore: 80 },
    })

    // Lead C — DNC phone → excludedCompliance.
    const c = await prisma.lead.create({
      data: { organizationId: orgId, displayName: 'C dnc', source: MARK, priorityScore: 70, timezone: 'America/New_York' },
    })
    await prisma.contact.create({
      data: {
        organizationId: orgId, leadId: c.id, displayName: 'C contact', timezone: 'America/New_York',
        phones: { create: { phone: '+1212555DNC0', type: 'mobile', isPrimary: true } },
      },
    })

    // Lead D — no timezone anywhere → timezone_unresolved fail-close.
    const dLead = await prisma.lead.create({
      data: { organizationId: orgId, displayName: 'D notz', source: MARK, priorityScore: 60, timezone: null },
    })
    await prisma.contact.create({
      data: {
        organizationId: orgId, leadId: dLead.id, displayName: 'D contact', timezone: null,
        phones: { create: { phone: '+12125550004', type: 'mobile', isPrimary: true } },
      },
    })

    const view = await prisma.savedView.create({
      data: {
        organizationId: orgId, name: 'Test Queue View', type: 'lead',
        sQuery: sourceQuery(MARK) as object,
        sort: [{ field: 'priorityScore', direction: 'desc' }],
      },
    })
    viewId = view.id

    const emptyView = await prisma.savedView.create({
      data: {
        organizationId: orgId, name: 'Empty Queue View', type: 'lead',
        sQuery: sourceQuery('TEST_QUEUE_NONE') as object,
        sort: [],
      },
    })
    emptyViewId = emptyView.id
  })

  afterAll(async () => {
    await prisma.contactPhone.deleteMany({ where: { contact: { lead: { source: MARK } } } })
    await prisma.contact.deleteMany({ where: { lead: { source: MARK } } })
    await prisma.lead.deleteMany({ where: { source: MARK } })
    await prisma.savedView.deleteMany({ where: { id: { in: [viewId, emptyViewId] } } })
  })

  it('resolves primacy, scrubs unconditionally, excludes no-phone + non-callable', async () => {
    let callerInvoked = false
    const caller: BatchCaller = async (body) => {
      callerInvoked = true
      return mockCaller(body)
    }
    const res = await getQueue(viewId, orgId, { caller })

    // Only Lead A survives.
    expect(res.leads.map((l) => l.displayName)).toEqual(['A callable'])
    const a = res.leads[0]
    expect(a.primaryPhoneE164).toBe('+12125550001')
    expect(a.contactId).toBeTruthy()
    expect(a.primaryPhoneId).toBeTruthy()
    expect(a.timezone).toBe('America/New_York')
    expect(a.ammunition.priorityScore).toBe(90)

    // Exclusions.
    expect(res.excludedNoPhone).toBe(1) // Lead B
    expect(res.excludedCompliance).toBe(2) // Lead C (dnc) + Lead D (timezone_unresolved)

    // Unconditional scrub fired even though the view has no callable_now predicate.
    expect(callerInvoked).toBe(true)

    // timezone_unresolved is contract-clean → stale stays FALSE.
    expect(res.stale).toBe(false)
    expect(res.staleReason).toBeUndefined()
  })

  it('D (no tz) sends NO fabricated timezone to compliance but displays America/New_York', async () => {
    const seen: Array<string | undefined> = []
    const caller: BatchCaller = async (body) => {
      for (const e of body.entries) if (e.phone === '+12125550004') seen.push(e.timezone)
      return mockCaller(body)
    }
    await getQueue(viewId, orgId, { caller })
    // D's compliance entry carried no timezone.
    expect(seen).toContain(undefined)
  })

  it('response shape has primaryPhoneE164 + all additive fields', async () => {
    const res = await getQueue(viewId, orgId, { caller: mockCaller })
    expect(res.view).toHaveProperty('id')
    expect(res.view).toHaveProperty('name')
    expect(typeof res.excludedNoPhone).toBe('number')
    expect(typeof res.excludedCompliance).toBe('number')
    expect(typeof res.stale).toBe('boolean')
    expect(typeof res.generatedAt).toBe('string')
    for (const l of res.leads) {
      expect(l).toHaveProperty('primaryPhoneE164')
      expect(l).not.toHaveProperty('primaryPhone')
      expect(l).toHaveProperty('displayName')
      expect(l).toHaveProperty('timezone')
      expect(l).toHaveProperty('primaryAddressSummary')
      expect(l.ammunition).toHaveProperty('captureStatus')
    }
  })

  it('empty view → empty leads + zero counts, caller not invoked', async () => {
    let invoked = false
    const caller: BatchCaller = async (body) => {
      invoked = true
      return mockCaller(body)
    }
    const res = await getQueue(emptyViewId, orgId, { caller })
    expect(res.leads).toEqual([])
    expect(res.excludedNoPhone).toBe(0)
    expect(res.excludedCompliance).toBe(0)
    expect(invoked).toBe(false)
  })

  it('compliance connectivity failure → all excluded, stale=true', async () => {
    const res = await getQueue(viewId, orgId, { caller: throwingCaller })
    expect(res.leads).toEqual([])
    // A, C, D had phones → all fail-closed under connectivity failure.
    expect(res.excludedCompliance).toBe(3)
    expect(res.stale).toBe(true)
    expect(res.staleReason).toBe('Compliance service unavailable')
  })
})
