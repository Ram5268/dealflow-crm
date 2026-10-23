// Brief 50 (PR 21), engineering precaution: tests/perf/25k.test.ts seeds and
// queries 25,000 made-up leads (scripts/seed-dev.ts, scripts/perf-25k.ts)
// against whatever database DATABASE_URL_PERF names. BRIEF_50.md's own
// "routine" local command for running the CRM's tests points DATABASE_URL_PERF
// at the shared Railway perf database the live CRM also shares -- so, before
// this PR, every ordinary local test run re-seeded and re-queried 25,000 rows
// there. This file is pure (no I/O), so both the test file and its unit test
// can import it without pulling in a database.
export const PERF_25K_OPT_IN_VAR = 'CRM_RUN_PERF_25K'

export function perf25kOptedIn(env: Record<string, string | undefined> = process.env): boolean {
  return env[PERF_25K_OPT_IN_VAR] === '1'
}

// One line, printed when the test is skipped, so the skip is visible in the
// log instead of just a quiet "0 tests" (test-all.sh's own summary notes it
// too). CI sets the opt-in itself (its own throwaway Postgres, never Railway).
export function perf25kSkipReason(): string {
  return (
    `SKIPPED tests/perf/25k.test.ts: set ${PERF_25K_OPT_IN_VAR}=1 to run it -- it seeds and queries 25,000 made-up ` +
    'leads against DATABASE_URL_PERF, which a routine local run points at the shared perf database the live CRM ' +
    `also shares. CI sets ${PERF_25K_OPT_IN_VAR}=1 (its own throwaway Postgres, not Railway).`
  )
}
