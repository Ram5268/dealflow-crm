import { describe, it, expect } from 'vitest'
import { compile, type CompileContext } from '@/lib/core-data/query-dsl/compiler'
import { buildSql, buildCountSql } from '@/lib/core-data/query-dsl/executor'
import type { SQuery } from '@/lib/core-data/query-dsl/schema'

const ctx: CompileContext = { organizationId: 'org_1', customFieldTypes: {} }

function leafNum(column: string, value: number): SQuery {
  return {
    type: 'field_condition',
    field: { kind: 'regular', table: 'lead', column },
    condition: { type: 'number', op: 'gte', value },
  }
}

describe('compiler — 4-level nesting', () => {
  it('compiles deeply nested and/or without stack issues and sequential params', () => {
    const q: SQuery = {
      type: 'and',
      queries: [
        {
          type: 'or',
          queries: [
            {
              type: 'and',
              queries: [
                {
                  type: 'or',
                  queries: [leafNum('priorityScore', 1), leafNum('topMatchFit', 2)],
                },
                leafNum('priorityScore', 3),
              ],
            },
            leafNum('topMatchFit', 4),
          ],
        },
        leafNum('priorityScore', 5),
      ],
    }
    const r = compile(q, ctx)
    // Params emitted left-to-right, sequentially numbered.
    expect(r.params).toEqual([1, 2, 3, 4, 5])
    expect(r.whereSql).toContain('$1')
    expect(r.whereSql).toContain('$5')
    // Balanced parens.
    const opens = (r.whereSql.match(/\(/g) ?? []).length
    const closes = (r.whereSql.match(/\)/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('very deep (20-level) nesting still compiles', () => {
    let node: SQuery = leafNum('priorityScore', 0)
    for (let i = 0; i < 20; i++) {
      node = { type: 'and', queries: [node, leafNum('priorityScore', i + 1)] }
    }
    const r = compile(node, ctx)
    expect(r.params.length).toBe(21)
  })
})

describe('executor — buildSql', () => {
  it('org-scopes with a trailing param and wraps where in parens', () => {
    const compiled = compile(leafNum('priorityScore', 50), ctx)
    const { sql, params } = buildSql(compiled, {
      organizationId: 'org_1',
      orderBySql: 'ORDER BY lead."priorityScore" DESC NULLS LAST',
      limit: 50,
    })
    expect(sql).toContain('FROM "Lead" lead')
    expect(sql).toContain('lead."organizationId" = $2')
    expect(sql).toContain('AND (lead."priorityScore" >= $1)')
    expect(sql).toContain('ORDER BY')
    expect(sql).toContain('LIMIT $3')
    expect(params).toEqual([50, 'org_1', 50])
  })

  it('adds OFFSET only when > 0', () => {
    const compiled = compile({ type: 'match_all' }, ctx)
    const withOffset = buildSql(compiled, {
      organizationId: 'o',
      limit: 10,
      offset: 20,
    })
    expect(withOffset.sql).toContain('OFFSET')
    const noOffset = buildSql(compiled, { organizationId: 'o', limit: 10, offset: 0 })
    expect(noOffset.sql).not.toContain('OFFSET')
  })

  it('custom select list is honored', () => {
    const compiled = compile({ type: 'match_all' }, ctx)
    const { sql } = buildSql(compiled, {
      organizationId: 'o',
      selectSql: 'lead.id, lead."displayName"',
    })
    expect(sql).toContain('SELECT lead.id, lead."displayName" FROM')
  })

  it('buildCountSql produces a COUNT projection', () => {
    const compiled = compile(leafNum('priorityScore', 1), ctx)
    const { sql, params } = buildCountSql(compiled, 'org_1')
    expect(sql).toContain('SELECT COUNT(*)::int AS count')
    expect(params).toEqual([1, 'org_1'])
  })
})
