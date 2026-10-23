import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertTestDatabase } from '../../src/lib/shared/db-guard'

type Env = Record<string, string | undefined>

// Brief 50 (6.14), engineering precaution: the database suites used to skip
// without a word when their setting was missing, so a CI edit that dropped
// DATABASE_URL_MAIN would have switched every integration-local suite off
// while CI stayed green. In CI they must run. GitHub Actions sets CI=true on
// every job, and ci.yml's db-suite job also sets CRM_TEST_DB_REQUIRED=1, so
// either one turns a missing setting into a failure.
export function databaseSuitesRequired(env: Env = process.env): boolean {
  const ci = (env.CI ?? '').trim().toLowerCase()
  return (ci !== '' && ci !== 'false' && ci !== '0') || env.CRM_TEST_DB_REQUIRED === '1'
}

const MAIN_MISSING_IN_CI =
  'DATABASE_URL_MAIN is not set, so the tests/integration-local suites would be skipped without a word. ' +
  'This run must use its test databases (CI=true or CRM_TEST_DB_REQUIRED=1), so they must run, not skip: ' +
  "set DATABASE_URL_MAIN to a *_test database (in CI, the db-suite job's env in .github/workflows/ci.yml)."

const PERF_MISSING =
  "DATABASE_URL_PERF is not set (or isn't a postgres:// URL). Suite 1 needs its own test database, " +
  "one whose name ends in _perf or _test: in CI the db-suite job's env in .github/workflows/ci.yml sets it; " +
  'locally, pass DATABASE_URL_PERF=<url> on the command line.'

// Brief 41 (H11): the integration-local suites run against DATABASE_URL_MAIN when
// it is set. They write rows, so they refuse anything but a *_perf / *_test
// database (the live CRM is never a test target). Unset → the suites skip on a
// local run (suite 1's globalSetup prints a loud warning first); in CI it is a
// failure (Brief 50).
export function mainIsTestDb(env: Env = process.env): boolean {
  const url = env.DATABASE_URL_MAIN
  if (!url) {
    if (databaseSuitesRequired(env)) throw new Error(MAIN_MISSING_IN_CI)
    return false
  }
  assertTestDatabase(url, 'tests/integration-local (DATABASE_URL_MAIN)', { allowOverride: false })
  return true
}

function integrationLocalFileCount(): number {
  try {
    return readdirSync(fileURLToPath(new URL('../integration-local', import.meta.url))).filter((f) => f.endsWith('.test.ts')).length
  } catch {
    return 0
  }
}

// Suite 1's globalSetup check, before anything touches a database. Throws when
// a setting is missing (DATABASE_URL_PERF anywhere, DATABASE_URL_MAIN in CI) or
// names a non-test database. Returns the warning to print when a local run will
// skip the integration-local suites, or null.
export function checkSuite1Databases(env: Env = process.env): string | null {
  const perf = env.DATABASE_URL_PERF
  if (!perf || !/^postgres(ql)?:\/\//.test(perf)) throw new Error(PERF_MISSING)
  // Brief 41 (H11): the suite writes (schema push, test rows), so it refuses any
  // database that isn't *_perf / *_test, including a live DATABASE_URL_MAIN that
  // a checkout's .env may carry (the integration-local suites use MAIN).
  assertTestDatabase(perf, 'the test suite (DATABASE_URL_PERF)', { allowOverride: false })
  if (mainIsTestDb(env)) return null
  const bar = '!'.repeat(78)
  return (
    `\n${bar}\n` +
    `WARNING: DATABASE_URL_MAIN is not set, so the ${integrationLocalFileCount()} test files in tests/integration-local will be SKIPPED.\n` +
    'CI runs them (its db-suite job). To run them here, set DATABASE_URL_MAIN to a *_test database with the\n' +
    'schema pushed and the org seeded (scripts/seed-main.ts), exactly as the db-suite job in .github/workflows/ci.yml does.\n' +
    `${bar}\n`
  )
}
