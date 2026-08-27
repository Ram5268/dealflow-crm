import { describe, it, expect } from 'vitest'
import {
  compile,
  compileOrderBy,
  CompileError,
  type CompileContext,
} from '@/lib/core-data/query-dsl/compiler'
import type { SQuery } from '@/lib/core-data/query-dsl/schema'

const ctx: CompileContext = {
  organizationId: 'org_1',
  customFieldTypes: {
    cf_price: 'number',
    cf_notes: 'text',
    cf_closing: 'date',
    cf_website: 'url',
  },
}

describe('compiler — node types', () => {
  it('match_all → TRUE, no params', () => {
    const r = compile({ type: 'match_all' }, ctx)
    expect(r.whereSql).toBe('TRUE')
    expect(r.params).toEqual([])
  })

  it('object_type lead → TRUE', () => {
    const r = compile({ type: 'object_type', object_type: 'lead' }, ctx)
    expect(r.whereSql).toBe('TRUE')
  })

  it('object_type contact → EXISTS subquery', () => {
    const r = compile({ type: 'object_type', object_type: 'contact' }, ctx)
    expect(r.whereSql).toContain('EXISTS')
    expect(r.whereSql).toContain('"Contact"')
  })

  it('and combines children with AND and parentheses', () => {
    const q: SQuery = {
      type: 'and',
      queries: [
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'lead', column: 'statusLabel' },
          condition: { type: 'term', op: 'in', values: ['Hot'] },
        },
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'lead', column: 'priorityScore' },
          condition: { type: 'number', op: 'gte', value: 50 },
        },
      ],
    }
    const r = compile(q, ctx)
    expect(r.whereSql.startsWith('(')).toBe(true)
    expect(r.whereSql).toContain(' AND ')
    expect(r.params).toEqual(['Hot', 50])
  })

  it('empty and → TRUE, empty or → FALSE', () => {
    expect(compile({ type: 'and', queries: [] }, ctx).whereSql).toBe('TRUE')
    expect(compile({ type: 'or', queries: [] }, ctx).whereSql).toBe('FALSE')
  })

  it('has_related contact compiles to correlated EXISTS', () => {
    const q: SQuery = {
      type: 'has_related',
      object_type: 'contact',
      query: {
        type: 'field_condition',
        field: { kind: 'regular', table: 'contact', column: 'title' },
        condition: { type: 'text', mode: 'exact', value: 'Owner' },
      },
    }
    const r = compile(q, ctx)
    expect(r.whereSql).toContain('EXISTS (SELECT 1 FROM "Contact"')
    expect(r.whereSql).toContain('c."leadId" = lead.id')
    expect(r.params).toEqual(['Owner'])
  })
})

describe('compiler — conditions', () => {
  const leadField = (column: string) =>
    ({ kind: 'regular', table: 'lead', column }) as const

  it('text exact → =', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('name'),
        condition: { type: 'text', mode: 'exact', value: 'Acme' },
      },
      ctx
    )
    expect(r.whereSql).toBe('lead."name" = $1')
    expect(r.params).toEqual(['Acme'])
  })

  it('text contains → ILIKE with escaped wildcards', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('name'),
        condition: { type: 'text', mode: 'contains', value: '50%_off' },
      },
      ctx
    )
    expect(r.whereSql).toBe('lead."name" ILIKE $1')
    // % and _ are escaped so they are literal, wrapped in %...%
    expect(r.params[0]).toBe('%50\\%\\_off%')
  })

  it('text full_words → regex word boundaries', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('description'),
        condition: { type: 'text', mode: 'full_words', value: 'condo' },
      },
      ctx
    )
    expect(r.whereSql).toBe('lead."description" ~* $1')
    expect(r.params[0]).toBe('\\ycondo\\y')
  })

  it('number ops map correctly', () => {
    const ops: Array<[string, string]> = [
      ['gt', '>'],
      ['lt', '<'],
      ['gte', '>='],
      ['lte', '<='],
      ['eq', '='],
    ]
    for (const [op, sql] of ops) {
      const r = compile(
        {
          type: 'field_condition',
          field: leadField('priorityScore'),
          condition: { type: 'number', op: op as never, value: 10 },
        },
        ctx
      )
      expect(r.whereSql).toBe(`lead."priorityScore" ${sql} $1`)
    }
  })

  it('number in → IN list of params', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('priorityScore'),
        condition: { type: 'number', op: 'in', values: [1, 2, 3] },
      },
      ctx
    )
    expect(r.whereSql).toBe('lead."priorityScore" IN ($1, $2, $3)')
    expect(r.params).toEqual([1, 2, 3])
  })

  it('number in [] → FALSE', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('priorityScore'),
        condition: { type: 'number', op: 'in', values: [] },
      },
      ctx
    )
    expect(r.whereSql).toBe('FALSE')
  })

  it('date before/after → </>', () => {
    const before = compile(
      {
        type: 'field_condition',
        field: leadField('createdAt'),
        condition: { type: 'date', op: 'before', value: '2026-01-01' },
      },
      ctx
    )
    expect(before.whereSql).toBe('lead."createdAt" < $1::timestamptz')
    const after = compile(
      {
        type: 'field_condition',
        field: leadField('createdAt'),
        condition: { type: 'date', op: 'after', value: '2026-01-01' },
      },
      ctx
    )
    expect(after.whereSql).toBe('lead."createdAt" > $1::timestamptz')
  })

  it('date between → two bounds, two params', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('createdAt'),
        condition: {
          type: 'date',
          op: 'between',
          from: '2026-01-01',
          to: '2026-02-01',
        },
      },
      ctx
    )
    expect(r.whereSql).toBe(
      'lead."createdAt" >= $1::timestamptz AND lead."createdAt" <= $2::timestamptz'
    )
    expect(r.params).toEqual(['2026-01-01', '2026-02-01'])
  })

  it('term in → IN list', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: leadField('statusLabel'),
        condition: { type: 'term', op: 'in', values: ['Hot', 'Warm'] },
      },
      ctx
    )
    expect(r.whereSql).toBe('lead."statusLabel" IN ($1, $2)')
    expect(r.params).toEqual(['Hot', 'Warm'])
  })
})

describe('compiler — custom fields', () => {
  it('number custom field → EXISTS on valueNumber', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: { kind: 'custom', definitionId: 'cf_price' },
        condition: { type: 'number', op: 'gte', value: 1_000_000 },
      },
      ctx
    )
    expect(r.whereSql).toContain('"CustomFieldValue" cfv')
    expect(r.whereSql).toContain('cfv."valueNumber" >= $2')
    // $1 is the definitionId param, $2 the value
    expect(r.params).toEqual(['cf_price', 1_000_000])
  })

  it('text custom field → valueText', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: { kind: 'custom', definitionId: 'cf_notes' },
        condition: { type: 'text', mode: 'contains', value: 'motivated' },
      },
      ctx
    )
    expect(r.whereSql).toContain('cfv."valueText" ILIKE $2')
  })

  it('date custom field → valueDate', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: { kind: 'custom', definitionId: 'cf_closing' },
        condition: { type: 'date', op: 'after', value: '2026-01-01' },
      },
      ctx
    )
    expect(r.whereSql).toContain('cfv."valueDate" > $2::timestamptz')
  })

  it('url custom field maps to valueText', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: { kind: 'custom', definitionId: 'cf_website' },
        condition: { type: 'text', mode: 'exact', value: 'x.com' },
      },
      ctx
    )
    expect(r.whereSql).toContain('cfv."valueText" = $2')
  })

  it('unknown custom field definition throws CompileError', () => {
    expect(() =>
      compile(
        {
          type: 'field_condition',
          field: { kind: 'custom', definitionId: 'cf_missing' },
          condition: { type: 'text', mode: 'exact', value: 'x' },
        },
        ctx
      )
    ).toThrow(CompileError)
  })
})

describe('compiler — compliance extraction', () => {
  it('compliance predicate lifted to compliancePredicates, emits TRUE', () => {
    const r = compile(
      {
        type: 'field_condition',
        field: { kind: 'compliance', predicate: 'callable_now' },
        condition: { type: 'term', op: 'in', values: ['x'] },
      },
      ctx
    )
    expect(r.whereSql).toBe('TRUE')
    expect(r.compliancePredicates).toEqual([{ predicate: 'callable_now' }])
    expect(r.params).toEqual([])
  })
})

describe('compiler — identifier safety', () => {
  it('unknown lead column throws (no injection via column name)', () => {
    expect(() =>
      compile(
        {
          type: 'field_condition',
          field: {
            kind: 'regular',
            table: 'lead',
            column: 'id; DROP TABLE "Lead"',
          },
          condition: { type: 'text', mode: 'exact', value: 'x' },
        },
        ctx
      )
    ).toThrow(CompileError)
  })

  it('unknown table throws', () => {
    expect(() =>
      compile(
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'secrets', column: 'x' },
          condition: { type: 'text', mode: 'exact', value: 'x' },
        },
        ctx
      )
    ).toThrow(CompileError)
  })

  it('type/column-kind mismatch throws', () => {
    expect(() =>
      compile(
        {
          type: 'field_condition',
          field: { kind: 'regular', table: 'lead', column: 'priorityScore' },
          condition: { type: 'text', mode: 'exact', value: 'x' },
        },
        ctx
      )
    ).toThrow(CompileError)
  })
})

describe('compileOrderBy', () => {
  it('defaults to priorityScore DESC NULLS LAST', () => {
    expect(compileOrderBy([])).toBe(
      'ORDER BY lead."priorityScore" DESC NULLS LAST'
    )
  })

  it('maps custom sort field + direction', () => {
    expect(
      compileOrderBy([{ field: 'updatedAt', direction: 'asc' }])
    ).toBe('ORDER BY lead."updatedAt" ASC NULLS LAST')
  })

  it('unknown sort field throws', () => {
    expect(() => compileOrderBy([{ field: 'hacky', direction: 'desc' }])).toThrow(
      CompileError
    )
  })
})
