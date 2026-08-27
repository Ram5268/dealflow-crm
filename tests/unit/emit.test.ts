import { describe, it, expect } from 'vitest'
import {
  emitWith,
  stripDiscriminants,
  NOTIFY_SAFE_BYTES,
  type EmitDeps,
} from '@/lib/core-data/events/emit'

function captureDeps() {
  const notified: Array<{ channel: string; payload: string }> = []
  const overflowed: Array<{ channel: string; payload: unknown }> = []
  const deps: EmitDeps = {
    notify: async (channel, payload) => {
      notified.push({ channel, payload })
    },
    storeOverflow: async (channel, payload) => {
      overflowed.push({ channel, payload })
      return 'overflow_1'
    },
  }
  return { deps, notified, overflowed }
}

describe('emit — stripDiscriminants', () => {
  it('removes eventName and type', () => {
    const out = stripDiscriminants({ eventName: 'x', type: 'y', leadId: 'l1', correlationId: 'c' })
    expect(out).not.toHaveProperty('eventName')
    expect(out).not.toHaveProperty('type')
    expect(out).toEqual({ leadId: 'l1', correlationId: 'c' })
  })
})

describe('emitWith', () => {
  it('small payload → notify with serialized JSON, no eventName', async () => {
    const { deps, notified, overflowed } = captureDeps()
    const res = await emitWith(deps, 'crm_lead_sync', {
      eventName: 'lead.upserted-from-import',
      leadId: 'l1',
      correlationId: 'c1',
    })
    expect(res.overflow).toBe(false)
    expect(overflowed).toHaveLength(0)
    expect(notified).toHaveLength(1)
    const parsed = JSON.parse(notified[0].payload)
    expect(parsed).not.toHaveProperty('eventName')
    expect(parsed.leadId).toBe('l1')
  })

  it('oversized payload → NotifyOverflow + small pointer with correlationId', async () => {
    const { deps, notified, overflowed } = captureDeps()
    const big = 'x'.repeat(NOTIFY_SAFE_BYTES + 100)
    const res = await emitWith(deps, 'crm_lead_sync', { blob: big, correlationId: 'c9' })
    expect(res.overflow).toBe(true)
    expect(res.overflowId).toBe('overflow_1')
    expect(overflowed).toHaveLength(1)
    const pointer = JSON.parse(notified[0].payload)
    expect(pointer).toEqual({ overflow: true, overflowId: 'overflow_1', correlationId: 'c9' })
  })
})
