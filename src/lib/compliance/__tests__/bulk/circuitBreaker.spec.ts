import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordVendorResult,
  isCircuitOpen,
  resumeCircuit,
  getCircuitState,
  resetCircuitsForTest,
} from '@/lib/compliance/bulk/circuitBreaker'

const T = 1_000_000

beforeEach(() => resetCircuitsForTest())

describe('circuitBreaker', () => {
  it('opens when error rate exceeds 20% over the window (>= 5 samples)', () => {
    recordVendorResult('dnc', false, T)
    recordVendorResult('dnc', false, T + 1)
    recordVendorResult('dnc', true, T + 2)
    recordVendorResult('dnc', true, T + 3)
    recordVendorResult('dnc', true, T + 4) // 2/5 = 40% > 20%
    expect(isCircuitOpen('dnc', T + 5)).toBe(true)
    expect(getCircuitState().dnc).toBe('open')
  })

  it('stays closed at exactly 20% error rate (needs strictly greater)', () => {
    recordVendorResult('litigator', false, T) // 1 error
    for (let i = 1; i < 5; i++) recordVendorResult('litigator', true, T + i) // 4 ok => 1/5 = 20%
    expect(isCircuitOpen('litigator', T + 5)).toBe(false)
  })

  it('does not trip below the minimum sample count', () => {
    for (let i = 0; i < 4; i++) recordVendorResult('dnc', false, T + i) // 4 errors, <5 samples
    expect(isCircuitOpen('dnc', T + 4)).toBe(false)
  })

  it('prunes samples older than the 5-minute window', () => {
    recordVendorResult('dnc', false, T) // lone old error
    const later = T + 6 * 60 * 1000
    for (let i = 0; i < 5; i++) recordVendorResult('dnc', true, later + i) // old error aged out
    expect(isCircuitOpen('dnc', later + 5)).toBe(false)
  })

  it('resume() closes a single circuit', () => {
    for (let i = 0; i < 5; i++) recordVendorResult('dnc', false, T + i)
    expect(isCircuitOpen('dnc', T + 5)).toBe(true)
    expect(resumeCircuit('dnc')).toEqual(['dnc'])
    expect(isCircuitOpen('dnc', T + 6)).toBe(false)
  })

  it('resume("all") closes both and reports both names', () => {
    for (let i = 0; i < 5; i++) recordVendorResult('dnc', false, T + i)
    for (let i = 0; i < 5; i++) recordVendorResult('litigator', false, T + i)
    expect(getCircuitState()).toEqual({ dnc: 'open', litigator: 'open' })
    expect(resumeCircuit('all')).toEqual(['dnc', 'litigator'])
    expect(getCircuitState()).toEqual({ dnc: 'closed', litigator: 'closed' })
  })
})
