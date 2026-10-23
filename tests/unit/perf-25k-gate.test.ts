import { describe, it, expect } from 'vitest'
import { PERF_25K_OPT_IN_VAR, perf25kOptedIn, perf25kSkipReason } from '../perf/perf-25k-gate'

// Brief 50 (PR 21), engineering precaution: tests/perf/25k.test.ts seeds and
// queries 25,000 made-up leads against DATABASE_URL_PERF, which a routine
// local test run points at the shared Railway perf database the live CRM also
// shares. Past this PR the test runs only when asked. Pure: no DB, no vitest
// collection (describe.skipIf itself is exercised by actually running the
// test file, not asserted here).

describe('the 25,000-lead speed test runs only when asked', () => {
  it('is off when the opt-in is unset', () => {
    expect(perf25kOptedIn({})).toBe(false)
  })

  it('is off for anything other than the exact opt-in value', () => {
    expect(perf25kOptedIn({ [PERF_25K_OPT_IN_VAR]: 'true' })).toBe(false)
    expect(perf25kOptedIn({ [PERF_25K_OPT_IN_VAR]: 'yes' })).toBe(false)
    expect(perf25kOptedIn({ [PERF_25K_OPT_IN_VAR]: '0' })).toBe(false)
    expect(perf25kOptedIn({ [PERF_25K_OPT_IN_VAR]: '' })).toBe(false)
  })

  it('is on with the exact opt-in value', () => {
    expect(perf25kOptedIn({ [PERF_25K_OPT_IN_VAR]: '1' })).toBe(true)
  })

  it("doesn't read any other setting", () => {
    expect(perf25kOptedIn({ CI: 'true', CRM_TEST_DB_REQUIRED: '1' })).toBe(false)
  })

  it('explains the skip in one line, naming the opt-in', () => {
    const reason = perf25kSkipReason()
    expect(reason).not.toContain('\n')
    expect(reason).toContain(PERF_25K_OPT_IN_VAR)
    expect(reason).toContain('tests/perf/25k.test.ts')
  })
})
