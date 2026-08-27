import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { runPerfSuite } from '../../scripts/perf-25k'

// ─────────────────────────────────────────────────────────────────────────────
// Gate 3 perf assertion: 20 realistic Smart-View queries against the 25k seed
// must hold p95 < 500ms (p99 < 1000ms). Runs against DATABASE_URL_PERF (must end
// in `_perf`). Requires the perf seed (scripts/seed-dev.ts) to have been run.
// ─────────────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL_PERF
const dbName = url ? new URL(url).pathname.replace(/^\//, '').split('?')[0] : ''
const enabled = !!url && dbName.endsWith('_perf')

let prisma: PrismaClient

describe.runIf(enabled)('perf — 25k smart-view queries', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } })
    // Guard: ensure the seed is present, else the assertion is meaningless.
    const count = await prisma.lead.count({ where: { organizationId: 'org_perf' } })
    if (count < 20_000) {
      throw new Error(
        `Perf seed missing: found ${count} leads in org_perf, expected 25k. Run: pnpm tsx scripts/seed-dev.ts`
      )
    }
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  it('p95 < 500ms, p99 < 1000ms across 20 queries', async () => {
    const summary = await runPerfSuite(prisma, 'org_perf', 8)
    // eslint-disable-next-line no-console
    console.log(
      `perf overall: p50=${summary.overallP50.toFixed(1)} p95=${summary.overallP95.toFixed(1)} p99=${summary.overallP99.toFixed(1)}`
    )
    expect(summary.overallP95).toBeLessThan(500)
    expect(summary.overallP99).toBeLessThan(1000)
  })
})
