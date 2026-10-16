// Brief 41 (H11): shell-script entry point for the live-database guard.
//   tsx scripts/assert-test-db.ts <ENV_VAR_NAME> <what>
// Exits 1 (after printing why) unless the database in $ENV_VAR_NAME is a
// *_perf / *_test database. Brief 41.1: no --i-mean-live override. Its one
// caller, run-isolation-boot.sh, migrates and seeds fake fixtures and never
// passes one on, so the refusal mustn't suggest it.
import { assertTestDatabase, scriptArgs } from '../src/lib/shared/db-guard'

const [envName, what = 'this script'] = scriptArgs()
try {
  if (!envName || envName.startsWith('-')) throw new Error('usage: assert-test-db.ts <ENV_VAR_NAME> <what>')
  assertTestDatabase(process.env[envName], `${what} (${envName})`, { allowOverride: false })
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
