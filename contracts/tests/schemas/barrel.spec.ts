import { describe, it, expect } from 'vitest'
import {
  CallConnectedEvent,
  CallCompletedEvent,
  PacingUpdateEvent,
  ScrubCompletedEvent,
  MessageReceivedEvent,
  LeadUpsertedFromImportEvent,
  LeadDerivedSignalsSyncedEvent,
  REASON_CODES,
} from './index'

// Preflight smoke test: proves the whole contract layer compiles, the barrel
// resolves, and each schema parses a representative payload. Slice agents add
// their own contract tests alongside this.

const CID = '11111111-1111-4111-8111-111111111111'

describe('event contracts parse a valid payload', () => {
  it('call.connected', () => {
    expect(
      CallConnectedEvent.parse({
        type: 'call.connected',
        callId: 'call_1',
        dialSessionId: 'dial_1',
        leadId: null,
        contactId: null,
        remotePhone: '+12125550100',
        connectedAt: '2026-08-27T00:00:00.000Z',
        correlationId: CID,
      }).type
    ).toBe('call.connected')
  })

  it('call.completed keeps cost as a string', () => {
    const parsed = CallCompletedEvent.parse({
      type: 'call.completed',
      callId: 'call_1',
      disposition: 'answered',
      duration: 42,
      cost: '0.0085',
      correlationId: CID,
    })
    expect(typeof parsed.cost).toBe('string')
  })

  it('dial-session.pacing-update', () => {
    expect(
      PacingUpdateEvent.parse({
        type: 'dial-session.pacing-update',
        dialSessionId: 'dial_1',
        currentLineCount: 3,
        abandonment30d: 0.01,
        correlationId: CID,
      }).currentLineCount
    ).toBe(3)
  })

  it('scrub.completed has no discriminant field', () => {
    const parsed = ScrubCompletedEvent.parse({
      phoneCount: 10,
      blockedCount: 2,
      checkedAt: '2026-08-27T00:00:00.000Z',
      correlationId: CID,
    })
    expect('type' in parsed).toBe(false)
    expect('eventName' in parsed).toBe(false)
  })

  it('message.received', () => {
    expect(
      MessageReceivedEvent.parse({
        messageId: 'msg_1',
        channel: 'sms',
        correlationId: CID,
      }).channel
    ).toBe('sms')
  })

  it('lead.upserted-from-import', () => {
    expect(
      LeadUpsertedFromImportEvent.parse({
        leadId: 'lead_1',
        sourceLabel: 'Mojo export',
        importBatchId: 'imp_1',
        correlationId: CID,
      }).importBatchId
    ).toBe('imp_1')
  })

  it('lead.derived-signals-synced', () => {
    expect(
      LeadDerivedSignalsSyncedEvent.parse({
        count: 5,
        syncedAt: '2026-08-27T00:00:00.000Z',
        correlationId: CID,
      }).count
    ).toBe(5)
  })
})

describe('reason codes', () => {
  it('exposes the frozen compliance vocabulary (Brief C §7A, 19 granular codes)', () => {
    expect(REASON_CODES).toContain('internal_dnc')
    expect(REASON_CODES).toContain('holiday_table_stale')
    expect(REASON_CODES).toContain('phone_missing')
    expect(REASON_CODES).toContain('vendor_error_dnc')
    expect(REASON_CODES).toContain('circuit_open_dnc')
    expect(REASON_CODES.length).toBe(19)
  })
})
