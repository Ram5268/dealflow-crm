import { describe, it, expect } from 'vitest'
import { emitWith, type EmitDeps } from '../../src/lib/core-data/events/emit'
import { LeadUpsertedFromImportEvent } from '../events/lead.upserted-from-import'
import { LeadDerivedSignalsSyncedEvent } from '../events/lead.derived-signals-synced'

// Gate 2 (A → services it OWNS): trigger A's emitters, capture the exact NOTIFY
// payload, and assert it (a) validates against the frozen zod schema and (b)
// carries NO eventName / type discriminant on the wire.

function capture() {
  const notified: Array<{ channel: string; payload: string }> = []
  const deps: EmitDeps = {
    notify: async (channel, payload) => { notified.push({ channel, payload }) },
    storeOverflow: async () => 'ov_1',
  }
  return { deps, notified }
}

describe('emits-events — lead.upserted-from-import', () => {
  it('matches the frozen schema and omits eventName/type', async () => {
    const { deps, notified } = capture()
    // emitWith is given a payload that even accidentally includes eventName/type.
    await emitWith(deps, 'crm_lead_sync', {
      eventName: 'lead.upserted-from-import',
      type: 'lead.upserted-from-import',
      leadId: 'lead_123',
      sourceLabel: 'Mojo Export',
      importBatchId: 'imp_1',
      correlationId: '11111111-1111-4111-8111-111111111111',
    })
    expect(notified).toHaveLength(1)
    expect(notified[0].channel).toBe('crm_lead_sync')
    const wire = JSON.parse(notified[0].payload)
    expect(wire).not.toHaveProperty('eventName')
    expect(wire).not.toHaveProperty('type')
    expect(() => LeadUpsertedFromImportEvent.parse(wire)).not.toThrow()
  })
})

describe('emits-events — lead.derived-signals-synced', () => {
  it('matches the frozen schema and omits eventName/type', async () => {
    const { deps, notified } = capture()
    await emitWith(deps, 'crm_lead_sync', {
      count: 42,
      syncedAt: '2026-08-27T00:00:00.000Z',
      correlationId: '22222222-2222-4222-8222-222222222222',
    })
    const wire = JSON.parse(notified[0].payload)
    expect(wire).not.toHaveProperty('eventName')
    expect(() => LeadDerivedSignalsSyncedEvent.parse(wire)).not.toThrow()
  })
})
