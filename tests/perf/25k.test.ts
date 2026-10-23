import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { runPerfSuite } from '../../scripts/perf-25k'
import { PERF_ORG_ID, PERF_TOTAL_LEADS, seedPerf } from '../../scripts/seed-dev'
import { withConnectionRetry } from '../setup/db-retry'
import { perfConnectionString } from '../setup/pg'
import { pushSchema } from '../setup/push-schema'
import { perf25kOptedIn, perf25kSkipReason } from './perf-25k-gate'

// ─────────────────────────────────────────────────────────────────────────────
// Gate 3 perf assertion: 20 realistic Smart-View queries against 25,000 leads
// must hold p95 < 500ms (p99 < 1000ms).
//
// Brief 50 (6.14): the test seeds its own made-up data (scripts/seed-dev.ts:
// fictional streets, phones only in 555-0100..0199) into its own Postgres
// schema, `perf_25k`, inside the suite's test database (DATABASE_URL_PERF,
// which must be a *_perf or *_test database; anything else is refused). So it
// never depends on a hand-seeded database and never sees other tests' rows.
// The schema is dropped before the seed and again afterwards.
//
// Brief 50 (PR 21), engineering precaution: that's still a real seed-and-query
// of 25,000 rows against whatever DATABASE_URL_PERF names, and BRIEF_50.md's
// own "routine" local command for the CRM's tests points it at the shared
// Railway perf database the live CRM also shares. So this file now runs only
// when asked (perf-25k-gate.ts's opt-in); CI sets the opt-in itself, since its
// db-suite job uses its own throwaway Postgres, never Railway.
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = 'perf_25k'
const optedIn = perf25kOptedIn()
if (!optedIn) {
  // eslint-disable-next-line no-console
  console.log(perf25kSkipReason())
}

// Prisma's own engine honours ?schema= (it sets the search path), and the
// Smart-View SQL names its tables unqualified, so every query runs in perf_25k.
function withSchema(url: string, schema: string | null): string {
  const u = new URL(url)
  if (schema) u.searchParams.set('schema', schema)
  u.searchParams.set('connection_limit', '3')
  return u.toString()
}

let admin: PrismaClient | undefined // the suite's database, to drop perf_25k
let prisma: PrismaClient | undefined // inside perf_25k

const dropSchema = () =>
  withConnectionRetry(`drop schema ${SCHEMA}`, () => admin!.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))

describe.skipIf(!optedIn)('perf — 25k smart-view queries', () => {
  beforeAll(async () => {
    const base = perfConnectionString() // refuses anything but a *_perf / *_test database
    admin = new PrismaClient({ datasourceUrl: withSchema(base, null) })
    await dropSchema()
    const url = withSchema(base, SCHEMA)
    const t0 = performance.now()
    await pushSchema(url, `tests/perf/25k (schema ${SCHEMA})`)
    prisma = new PrismaClient({ datasourceUrl: url })
    const counts = await seedPerf(prisma, { retry: withConnectionRetry })
    // eslint-disable-next-line no-console
    console.log(
      `perf seed (schema ${SCHEMA}): ${counts.leads} leads, ${counts.contacts} contacts, ${counts.phones} phones, ` +
        `${counts.values} custom values in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    )
    expect(counts.leads).toBe(PERF_TOTAL_LEADS)
  }, 900_000)

  afterAll(async () => {
    await prisma?.$disconnect()
    if (admin) {
      await dropSchema()
      await admin.$disconnect()
    }
  }, 300_000)

  it('p95 < 500ms, p99 < 1000ms across 20 queries', async () => {
    const summary = await runPerfSuite(prisma!, PERF_ORG_ID, 8)
    // eslint-disable-next-line no-console
    console.log(
      summary.perQuery.map((r) => `  ${r.name.padEnd(34)} p50=${r.p50.toFixed(1)} p95=${r.p95.toFixed(1)} rows=${r.rows}`).join('\n') +
        `\nperf overall: p50=${summary.overallP50.toFixed(1)} p95=${summary.overallP95.toFixed(1)} p99=${summary.overallP99.toFixed(1)}`,
    )
    // Every query finds rows, so the timing is of real work, not of an empty table.
    for (const r of summary.perQuery) expect(r.rows, r.name).toBeGreaterThan(0)
    expect(summary.overallP95).toBeLessThan(500)
    expect(summary.overallP99).toBeLessThan(1000)
  })
})
