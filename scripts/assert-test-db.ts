// Brief 41 (H11): shell-script entry point for the live-database guard.
//   tsx scripts/assert-test-db.ts <ENV_VAR_NAME> <what> [--i-mean-live]
// Exits 1 (after printing why) unless the database in $ENV_VAR_NAME is a
// *_perf / *_test database, or --i-mean-live is passed.
import { assertTestDatabase, scriptArgs } from '../src/lib/shared/db-guard'

const [envName, what = 'this script'] = scriptArgs()
try {
  if (!envName || envName.startsWith('-')) throw new Error('usage: assert-test-db.ts <ENV_VAR_NAME> <what> [--i-mean-live]')
  assertTestDatabase(process.env[envName], `${what} (${envName})`, { allowOverride: true })
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
