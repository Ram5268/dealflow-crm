import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { compile, compileOrderBy, type CompileContext } from '../src/lib/core-data/query-dsl/compiler'
import { execute } from '../src/lib/core-data/query-dsl/executor'
import type { SQuery } from '../src/lib/core-data/query-dsl/schema'

// ─────────────────────────────────────────────────────────────────────────────
// 25k-row perf harness. Runs 20 realistic Smart-View queries against the perf
// seed, records p50/p95/p99 per query, and asserts the aggregate p95 < 500ms.
// Importable (runPerfSuite) so tests/perf/25k.test.ts reuses the exact logic.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = 'org_perf'

// Custom field types matching seed-dev's CUSTOM_DEFS (cf_seed_0..9).
const customFieldTypes: CompileContext['customFieldTypes'] = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    `cf_seed_${i}`,
    i % 3 === 0 ? 'number' : i % 3 === 1 ? 'text' : 'date',
  ])
) as CompileContext['customFieldTypes']

const leadNum = (column: string, op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq', value: number): SQuery => ({
  type: 'field_condition',
  field: { kind: 'regular', table: 'lead', column },
  condition: { type: 'number', op, value },
})

export const PERF_QUERIES: Array<{ name: string; q: SQuery }> = [
  { name: 'match_all', q: { type: 'match_all' } },
  {
    name: 'status in [Hot,Warm]',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'statusLabel' },
      condition: { type: 'term', op: 'in', values: ['Hot', 'Warm'] },
    },
  },
  { name: 'priority >= 50', q: leadNum('priorityScore', 'gte', 50) },
  {
    name: 'priority between 30..70',
    q: { type: 'and', queries: [leadNum('priorityScore', 'gte', 30), leadNum('priorityScore', 'lte', 70)] },
  },
  {
    name: 'displayName contains',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'displayName' },
      condition: { type: 'text', mode: 'contains', value: 'Lead 1' },
    },
  },
  {
    name: 'mojoId exact',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'mojoId' },
      condition: { type: 'text', mode: 'exact', value: 'mojo_1000' },
    },
  },
  {
    name: 'custom number >= 1M',
    q: {
      type: 'field_condition',
      field: { kind: 'custom', definitionId: 'cf_seed_0' },
      condition: { type: 'number', op: 'gte', value: 1_000_000 },
    },
  },
  {
    name: 'custom text contains',
    q: {
      type: 'field_condition',
      field: { kind: 'custom', definitionId: 'cf_seed_1' },
      condition: { type: 'text', mode: 'contains', value: 'note 5' },
    },
  },
  {
    name: 'has_related contact title=Owner',
    q: {
      type: 'has_related',
      object_type: 'contact',
      query: {
        type: 'field_condition',
        field: { kind: 'regular', table: 'contact', column: 'title' },
        condition: { type: 'text', mode: 'exact', value: 'Owner' },
      },
    },
  },
  {
    name: 'phone type=mobile (auto-EXISTS)',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'contactPhone', column: 'type' },
      condition: { type: 'term', op: 'in', values: ['mobile'] },
    },
  },
  {
    name: 'and(status in, priority gte)',
    q: {
      type: 'and',
      queries: [
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'lead', column: 'statusLabel' },
          condition: { type: 'term', op: 'in', values: ['Hot', 'Warm', 'Cold'] },
        },
        leadNum('priorityScore', 'gte', 40),
      ],
    },
  },
  {
    name: 'or(status Hot, priority gte 80)',
    q: {
      type: 'or',
      queries: [
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'lead', column: 'statusLabel' },
          condition: { type: 'text', mode: 'exact', value: 'Hot' },
        },
        leadNum('priorityScore', 'gte', 80),
      ],
    },
  },
  { name: 'object_type contact', q: { type: 'object_type', object_type: 'contact' } },
  {
    name: 'nested 3-level',
    q: {
      type: 'and',
      queries: [
        {
          type: 'or',
          queries: [leadNum('priorityScore', 'gte', 60), leadNum('topMatchFit', 'gte', 60)],
        },
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'lead', column: 'captureStatus' },
          condition: { type: 'term', op: 'in', values: ['EXTERNAL_BOTH', 'OWN_BOTH_SIDES'] },
        },
      ],
    },
  },
  {
    name: 'captureStatus term in',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'captureStatus' },
      condition: { type: 'term', op: 'in', values: ['OWN_BUYER_ONLY'] },
    },
  },
  {
    name: 'createdAt after',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'createdAt' },
      condition: { type: 'date', op: 'after', value: '2000-01-01T00:00:00Z' },
    },
  },
  {
    name: 'name full_words',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'name' },
      condition: { type: 'text', mode: 'full_words', value: 'Owner' },
    },
  },
  { name: 'topMatchFit gte 50', q: leadNum('topMatchFit', 'gte', 50) },
  {
    name: 'and(phone mobile, priority gte)',
    q: {
      type: 'and',
      queries: [
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'contactPhone', column: 'type' },
          condition: { type: 'term', op: 'in', values: ['mobile'] },
        },
        leadNum('priorityScore', 'gte', 30),
      ],
    },
  },
  {
    name: 'source contains import:',
    q: {
      type: 'field_condition',
      field: { kind: 'regular', table: 'lead', column: 'source' },
      condition: { type: 'text', mode: 'contains', value: 'import:' },
    },
  },
]

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

export interface PerfResult {
  name: string
  runs: number
  p50: number
  p95: number
  p99: number
  rows: number
}

export interface PerfSummary {
  perQuery: PerfResult[]
  overallP50: number
  overallP95: number
  overallP99: number
}

export async function runPerfSuite(
  prisma: PrismaClient,
  orgId: string = ORG_ID,
  runsPerQuery = 8
): Promise<PerfSummary> {
  const orderBySql = compileOrderBy([{ field: 'priorityScore', direction: 'desc' }])
  const perQuery: PerfResult[] = []
  const allTimings: number[] = []

  for (const { name, q } of PERF_QUERIES) {
    const compiled = compile(q, { organizationId: orgId, customFieldTypes })
    const timings: number[] = []
    let rows = 0
    // One warm-up run (plan cache) not counted.
    await execute(compiled, prisma, { organizationId: orgId, orderBySql, limit: 50 })
    for (let r = 0; r < runsPerQuery; r++) {
      const t0 = performance.now()
      const result = await execute(compiled, prisma, { organizationId: orgId, orderBySql, limit: 50 })
      const dt = performance.now() - t0
      timings.push(dt)
      allTimings.push(dt)
      rows = result.length
    }
    timings.sort((a, b) => a - b)
    perQuery.push({
      name,
      runs: runsPerQuery,
      p50: percentile(timings, 50),
      p95: percentile(timings, 95),
      p99: percentile(timings, 99),
      rows,
    })
  }

  allTimings.sort((a, b) => a - b)
  return {
    perQuery,
    overallP50: percentile(allTimings, 50),
    overallP95: percentile(allTimings, 95),
    overallP99: percentile(allTimings, 99),
  }
}

async function main() {
  const url = process.env.DATABASE_URL_PERF
  const dbName = url ? new URL(url).pathname.replace(/^\//, '').split('?')[0] : '(unset)'
  if (!url || !dbName.endsWith('_perf')) {
    console.error(`REFUSING: DATABASE_URL_PERF db "${dbName}" must end with "_perf".`)
    process.exit(1)
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } })
  const summary = await runPerfSuite(prisma)
  console.log('\nPer-query (ms):')
  for (const r of summary.perQuery) {
    console.log(
      `  ${r.name.padEnd(34)} p50=${r.p50.toFixed(1).padStart(7)} p95=${r.p95.toFixed(1).padStart(7)} p99=${r.p99.toFixed(1).padStart(7)}  rows=${r.rows}`
    )
  }
  console.log(
    `\nOVERALL  p50=${summary.overallP50.toFixed(1)}  p95=${summary.overallP95.toFixed(1)}  p99=${summary.overallP99.toFixed(1)}`
  )
  console.log(summary.overallP95 < 500 ? 'PASS: p95 < 500ms' : 'FAIL: p95 >= 500ms')
  await prisma.$disconnect()
  process.exit(summary.overallP95 < 500 ? 0 : 1)
}

// Run as CLI only when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('perf-25k.ts')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
