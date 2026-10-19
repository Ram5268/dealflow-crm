import { describe, it, expect } from 'vitest'
import { queueOrder } from '@/lib/core-data/smart-view/queue-service'
import { compile, compileOrderBy } from '@/lib/core-data/query-dsl/compiler'
import { buildSql } from '@/lib/core-data/query-dsl/executor'
import { DEFAULT_VIEW } from '@/lib/core-data/smart-view/defaultView'
import type { SortSpec } from '@/lib/core-data/query-dsl/schema'

// Brief 50 PR 10 (open item 6.8): the Queue's ORDER BY. DealFlow's rank leads
// whenever the view is ordered by DealFlow's priority; the view's own sort and
// lead.id still follow, so leads with no rank keep a stable place after the
// ranked ones. The DB-backed proof is tests/integration-local/queue-order.test.ts.
const ORG = 'org_unit_test'
const compiled = () => compile(DEFAULT_VIEW.sQuery, { organizationId: ORG, customFieldTypes: {} })
const RANK_FIRST = /^ORDER BY \(\(SELECT jsonb_object_agg\(/

describe('queueOrder', () => {
  it('the "DealFlow priority" view: DealFlow rank first (no rank last), then the view\'s sort, then lead.id', () => {
    const c = compiled()
    const { orderBySql } = queueOrder(c, DEFAULT_VIEW.sort, ORG)
    expect(orderBySql).toMatch(RANK_FIRST)
    expect(orderBySql).toMatch(/->> lead\.id\)::int ASC NULLS LAST, /)
    expect(orderBySql.endsWith(compileOrderBy(DEFAULT_VIEW.sort).replace(/^ORDER BY /, ', '))).toBe(true)
    expect(orderBySql).toMatch(/, lead\.id ASC$/)
  })

  it('no saved sort means priority first (compileOrderBy\'s default), so the rank leads there too', () => {
    const { orderBySql } = queueOrder(compiled(), [], ORG)
    expect(orderBySql).toMatch(RANK_FIRST)
    expect(orderBySql).toMatch(/ASC NULLS LAST, lead\."priorityScore" DESC NULLS LAST, lead\.id ASC$/)
  })

  it('lowest priority first reads the rank backwards; unranked still last', () => {
    const { orderBySql } = queueOrder(compiled(), [{ field: 'priorityScore', direction: 'asc' }], ORG)
    expect(orderBySql).toMatch(RANK_FIRST)
    expect(orderBySql).toMatch(/->> lead\.id\)::int DESC NULLS LAST, lead\."priorityScore" ASC NULLS LAST, lead\.id ASC$/)
  })

  it('a view sorted by something else keeps its own order and adds no parameter', () => {
    for (const sort of [
      [{ field: 'displayName', direction: 'asc' }],
      [{ field: 'topMatchFit', direction: 'desc' }, { field: 'priorityScore', direction: 'desc' }],
    ] as SortSpec[]) {
      const c = compiled()
      const out = queueOrder(c, sort, ORG)
      expect(out.orderBySql).toBe(compileOrderBy(sort))
      expect(out.compiled).toBe(c)
    }
  })

  it('reads only this organization\'s signals, as a bound parameter of its own (never inlined)', () => {
    const c = compiled()
    const before = [...c.params]
    const out = queueOrder(c, DEFAULT_VIEW.sort, ORG)
    expect(c.params).toEqual(before) // the caller's query is not changed
    expect(out.compiled.whereSql).toBe(c.whereSql)
    expect(out.compiled.params).toEqual([...before, ORG])
    const ph = `$${before.length + 1}`
    expect(out.orderBySql).toContain(`s."organizationId" = ${ph}`)
    expect(out.orderBySql).toContain(`by_id."organizationId" = ${ph}`)
    expect(out.orderBySql).toContain(`by_mojo."organizationId" = ${ph}`)
    expect(out.orderBySql).not.toContain(ORG)

    // In the executor's statement the extra parameter sits before its own
    // organization and limit parameters, so every placeholder still lines up.
    const built = buildSql(out.compiled, { organizationId: ORG, orderBySql: out.orderBySql, limit: 5 })
    expect(built.params).toEqual([...before, ORG, ORG, 5])
    expect(built.sql).toContain(`lead."organizationId" = $${before.length + 2}`)
    expect(built.sql).toMatch(new RegExp(`LIMIT \\$${before.length + 3}$`))
  })

  it('maps a signal to a lead the way the morning copy does: the lead DealFlow names, else the Mojo ID; ranked signals only', () => {
    const { orderBySql } = queueOrder(compiled(), DEFAULT_VIEW.sort, ORG)
    expect(orderBySql).toContain(`by_id.id = s."dealflowRawJson"->>'crmLeadId'`)
    expect(orderBySql).toContain('by_mojo."mojoId" = s."mojoId"')
    expect(orderBySql).toContain('COALESCE(by_id.id, by_mojo.id)')
    expect(orderBySql).toContain('min(s."queueRank")')
    expect(orderBySql).toContain('s."queueRank" IS NOT NULL')
  })
})
