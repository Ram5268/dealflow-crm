import { assertTestDatabase } from '@/lib/shared/db-guard'

// Brief 41 (H11): the integration-local suites run against DATABASE_URL_MAIN when
// it is set. They write rows, so they refuse anything but a *_perf / *_test
// database (the live CRM is never a test target). Unset → the suites skip.
export function mainIsTestDb(): boolean {
  const url = process.env.DATABASE_URL_MAIN
  if (!url) return false
  assertTestDatabase(url, 'tests/integration-local (DATABASE_URL_MAIN)', { allowOverride: false })
  return true
}
