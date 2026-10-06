// Brief 41 (H11): shell-script entry point for the live-database guard.
//   tsx scripts/assert-test-db.ts <ENV_VAR_NAME> <what> [--i-mean-live]
// Exits 1 (after printing why) unless the database in $ENV_VAR_NAME is a
// *_perf / *_test database, or --i-mean-live is passed.
import { assertTestDatabase } from '../src/lib/shared/db-guard'

const [envName, what = 'this script'] = process.argv.slice(2)
try {
  assertTestDatabase(envName ? process.env[envName] : undefined, `${what} (${envName ?? 'no env var named'})`)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
