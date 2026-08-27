import { describe, it, expect } from 'vitest'
import { POST } from '@/app/api/compliance/callable-now/route'

// Gate 2 — the 100-id batch cap. A request above the cap must be rejected with
// HTTP 413 BEFORE any DB work, with the exact body Agent A/B assert against.
function post(body: unknown) {
  return POST(
    new Request('http://local/api/compliance/callable-now', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 't' },
      body: JSON.stringify(body),
    })
  )
}

describe('POST /api/compliance/callable-now — batch cap', () => {
  it('101 ids -> 413 with { error, maxItems, receivedItems }', async () => {
    const res = await post({ contactPhoneIds: Array.from({ length: 101 }, (_, i) => `cp_${i}`) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'batch_too_large', maxItems: 100, receivedItems: 101 })
  })

  it('exactly 100 ids does NOT 413 (cap is inclusive)', async () => {
    // With no DB in isolation the org lookup fails -> 500, but crucially NOT 413.
    const res = await post({ contactPhoneIds: Array.from({ length: 100 }, (_, i) => `cp_${i}`) })
    expect(res.status).not.toBe(413)
  })

  it('rejects a non-array contactPhoneIds with 400', async () => {
    const res = await post({ contactPhoneIds: 'nope' })
    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await POST(
      new Request('http://local/api/compliance/callable-now', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
    )
    expect(res.status).toBe(400)
  })
})
