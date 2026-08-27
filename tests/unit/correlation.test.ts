import { describe, it, expect } from 'vitest'
import {
  newCorrelationId,
  runWithCorrelationId,
  getCorrelationId,
  CORRELATION_HEADER,
} from '@/lib/shell/correlationId'

describe('correlation id', () => {
  it('newCorrelationId returns a non-empty unique-ish string', () => {
    const a = newCorrelationId()
    const b = newCorrelationId()
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('runWithCorrelationId binds getCorrelationId inside the callback', () => {
    expect(getCorrelationId()).toBeUndefined()
    const id = 'cid-fixed'
    const seen = runWithCorrelationId(id, () => getCorrelationId())
    expect(seen).toBe(id)
    // Escapes the scope afterward.
    expect(getCorrelationId()).toBeUndefined()
  })

  it('header constant is x-correlation-id', () => {
    expect(CORRELATION_HEADER).toBe('x-correlation-id')
  })
})
