// `prisma db push` of the merged schema into a test database: suite 1's
// globalSetup (the suite's own database) and tests/perf/25k (its own schema).
// Brief 50 (6.14), engineering precaution: a dropped connection during the push
// is retried (db-retry.ts), and Prisma's output is shown without the database
// address. Every caller has already checked the database is a test one; this
// checks again, with no override.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertTestDatabase } from '../../src/lib/shared/db-guard'
import { redactDatabaseHosts, withConnectionRetry } from './db-retry'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export async function pushSchema(url: string, what: string): Promise<void> {
  assertTestDatabase(url, what, { allowOverride: false })
  await withConnectionRetry(`prisma db push (${what})`, async () => {
    // --accept-data-loss: additive index/default changes (§13 S1/S2) are flagged
    // as potentially destructive by `db push`; test databases hold disposable data.
    const r = spawnSync('node_modules/.bin/prisma', ['db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: REPO_ROOT,
      // The datasource is env("DATABASE_URL_MAIN"): point it at the test database.
      env: { ...process.env, DATABASE_URL_MAIN: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
      timeout: 300_000,
    })
    const output = redactDatabaseHosts(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`).trim()
    if (r.status !== 0) throw new Error(`prisma db push failed for ${what}:\n${output}`)
    console.log(output)
  })
}
