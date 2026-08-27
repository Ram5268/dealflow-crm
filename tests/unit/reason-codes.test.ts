import { describe, it, expect } from 'vitest'
import {
  REASON_CODES,
  areReasonsKnown,
  unknownReasons,
} from '@/lib/shared/reason-codes'

describe('reason-codes', () => {
  it('includes timezone_unresolved (A fail-closed fallback)', () => {
    expect(REASON_CODES).toContain('timezone_unresolved')
  })

  it('areReasonsKnown true for known, false with any unknown', () => {
    expect(areReasonsKnown(['internal_dnc', 'federal_dnc'])).toBe(true)
    expect(areReasonsKnown([])).toBe(true)
    expect(areReasonsKnown(['internal_dnc', 'made_up_code'])).toBe(false)
  })

  it('unknownReasons returns only the out-of-enum values', () => {
    expect(unknownReasons(['internal_dnc', 'nope', 'litigator', 'bad'])).toEqual([
      'nope',
      'bad',
    ])
  })
})
