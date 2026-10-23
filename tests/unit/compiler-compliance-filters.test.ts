import { describe, it, expect } from 'vitest'
import { compile, CompileError, type CompileContext } from '@/lib/core-data/query-dsl/compiler'
import * as dsl from '@/lib/core-data/query-dsl/schema'
import { narrowingPredicatesIn } from '@/lib/core-data/query-dsl/compliance-filters'
import type { SQuery } from '@/lib/core-data/query-dsl/schema'

// Brief 50 PR 4 (open item 6.4, audit finding L15): the Smart View filters
// "Do-not-call clean" (dnc_clean) and "Callable now" (callable_now) used to
// compile to TRUE, so a view using either silently showed everyone.
//  - dnc_clean now compiles to SQL over the do-not-call data the CRM already
//    stores (no vendor, no network); tests/smart-view.compliance-filters.test.ts
//    proves which leads it keeps on a real database.
//  - callable_now is hidden: the compiler, the Smart View API's schema and the
//    saved-view reader refuse it with a plain message instead of ignoring it.

const ctx: CompileContext = { organizationId: 'org_1', customFieldTypes: {} }

const DNC_CLEAN: SQuery = {
  type: 'field_condition',
  field: { kind: 'compliance', predicate: 'dnc_clean' },
  condition: { type: 'term', op: 'in', values: ['true'] },
}
const CALLABLE_NOW: SQuery = {
  type: 'field_condition',
  field: { kind: 'compliance', predicate: 'callable_now' },
  condition: { type: 'term', op: 'in', values: ['true'] },
}
const HOT: SQuery = {
  type: 'field_condition',
  field: { kind: 'regular', table: 'lead', column: 'statusLabel' },
  condition: { type: 'term', op: 'in', values: ['Hot'] },
}
const PRIORITY_50: SQuery = {
  type: 'field_condition',
  field: { kind: 'regular', table: 'lead', column: 'priorityScore' },
  condition: { type: 'number', op: 'gte', value: 50 },
}

const NOT_AVAILABLE = /"Callable now" filter isn't available yet/

describe('compiler: "Do-not-call clean" (dnc_clean)', () => {
  it('compiles to a real filter over the stored do-not-call data, not TRUE', () => {
    const r = compile(DNC_CLEAN, ctx)
    expect(r.whereSql).not.toBe('TRUE')
    // The internal opt-out list and federal/state hits, known litigators,
    // recent registry checks, and a texted STOP.
    expect(r.whereSql).toContain('"DncSuppression"')
    expect(r.whereSql).toContain('"LitigatorSuppression"')
    expect(r.whereSql).toContain('"ScrubLog"')
    expect(r.whereSql).toContain('"outboundSmsBlocked"')
    // Every stored-data lookup is scoped to the organization, as a bound value.
    expect(r.params).toEqual(['org_1'])
    expect(r.whereSql).toContain('"organizationId" = $1')
  })

  it('leaves nothing behind for a later step to evaluate (that step never existed)', () => {
    expect(compile(DNC_CLEAN, ctx)).not.toHaveProperty('compliancePredicates')
  })

  it('never reaches a vendor or the network: SQL only, no callable-now service', () => {
    const r = compile(DNC_CLEAN, ctx)
    expect(r.whereSql).not.toMatch(/callable-now|https?:/i)
  })

  it('keeps placeholders in order inside and / or / has_related', () => {
    const and = compile({ type: 'and', queries: [HOT, DNC_CLEAN, PRIORITY_50] }, ctx)
    expect(and.params).toEqual(['Hot', 'org_1', 50])
    expect(and.whereSql).toContain('lead."statusLabel" IN ($1)')
    expect(and.whereSql).toContain('"organizationId" = $2')
    expect(and.whereSql).toContain('lead."priorityScore" >= $3')

    const or = compile({ type: 'or', queries: [DNC_CLEAN, HOT] }, ctx)
    expect(or.params).toEqual(['org_1', 'Hot'])
    expect(or.whereSql).toContain(' OR ')

    const nested = compile({ type: 'has_related', object_type: 'contact', query: DNC_CLEAN }, ctx)
    expect(nested.whereSql.startsWith('EXISTS (SELECT 1 FROM "Contact" c')).toBe(true)
    expect(nested.params).toEqual(['org_1'])

    // Balanced parentheses: the fragment drops into any surrounding query.
    const opens = (and.whereSql.match(/\(/g) ?? []).length
    const closes = (and.whereSql.match(/\)/g) ?? []).length
    expect(opens).toBe(closes)
  })
})

describe('"Do-not-call clean" takes only its "true" form', () => {
  const NOT_CLEAN: SQuery = { ...DNC_CLEAN, condition: { type: 'term', op: 'in', values: ['false'] } } as SQuery
  const MESSAGE = /"Do-not-call clean" filter only keeps people who are do-not-call clean/

  it('any other condition is refused (it would otherwise return the clean people)', () => {
    expect(() => compile(NOT_CLEAN, ctx)).toThrow(MESSAGE)
    expect(() => compile({ ...DNC_CLEAN, condition: { type: 'text', mode: 'exact', value: 'true' } } as SQuery, ctx)).toThrow(CompileError)
    const r = dsl.sQuerySchema.safeParse({ type: 'and', queries: [HOT, NOT_CLEAN] })
    expect(r.success).toBe(false)
    expect(r.error?.issues.map((i) => i.message).join(' ')).toMatch(MESSAGE)
  })
})

describe('when "Do-not-call clean" narrows the list (for the Leads page note)', () => {
  it('counts it under and / has_related, not as one alternative of an or', () => {
    expect(narrowingPredicatesIn({ type: 'and', queries: [HOT, DNC_CLEAN] })).toEqual(['dnc_clean'])
    expect(narrowingPredicatesIn({ type: 'has_related', object_type: 'contact', query: DNC_CLEAN })).toEqual(['dnc_clean'])
    expect(narrowingPredicatesIn({ type: 'or', queries: [DNC_CLEAN] })).toEqual(['dnc_clean'])
    expect(narrowingPredicatesIn({ type: 'or', queries: [HOT, DNC_CLEAN] })).toEqual([])
    expect(narrowingPredicatesIn({ type: 'and', queries: [HOT, { type: 'or', queries: [PRIORITY_50, DNC_CLEAN] }] })).toEqual([])
  })
})

describe('compiler: "Callable now" (callable_now) is hidden', () => {
  it('is refused with a plain error instead of being ignored', () => {
    expect(() => compile(CALLABLE_NOW, ctx)).toThrow(CompileError)
    expect(() => compile(CALLABLE_NOW, ctx)).toThrow(NOT_AVAILABLE)
  })

  it('is refused wherever it sits in the query', () => {
    const deep: SQuery = {
      type: 'or',
      queries: [HOT, { type: 'has_related', object_type: 'contact', query: { type: 'and', queries: [PRIORITY_50, CALLABLE_NOW] } }],
    }
    expect(() => compile(deep, ctx)).toThrow(NOT_AVAILABLE)
  })
})

describe('Smart View API schema (POST/PUT /api/smart-views, POST /api/data/search)', () => {
  it('refuses a query that uses "Callable now", with the plain message', () => {
    for (const q of [CALLABLE_NOW, { type: 'and', queries: [HOT, CALLABLE_NOW] }]) {
      const r = dsl.sQuerySchema.safeParse(q)
      expect(r.success).toBe(false)
      expect(r.error?.issues.map((i) => i.message).join(' ')).toMatch(NOT_AVAILABLE)
    }
  })

  it('accepts "Do-not-call clean" and ordinary filters', () => {
    expect(dsl.sQuerySchema.safeParse(DNC_CLEAN).success).toBe(true)
    expect(dsl.sQuerySchema.safeParse({ type: 'and', queries: [HOT, DNC_CLEAN] }).success).toBe(true)
  })
})

describe('reading a saved Smart View', () => {
  it('a view saved before the filter was hidden fails with the plain message, not a silent "everyone"', () => {
    expect(typeof dsl.parseSavedViewQuery).toBe('function')
    expect(() => dsl.parseSavedViewQuery({ type: 'and', queries: [HOT, CALLABLE_NOW] })).toThrow(NOT_AVAILABLE)
    expect(() => dsl.parseSavedViewQuery(CALLABLE_NOW)).toThrow(dsl.UnavailableFilterError)
  })

  it('a view using "Do-not-call clean" reads normally', () => {
    expect(dsl.parseSavedViewQuery(DNC_CLEAN)).toEqual(DNC_CLEAN)
  })

  it('a malformed view still fails as before', () => {
    expect(() => dsl.parseSavedViewQuery({ type: 'nonsense' })).toThrow()
  })
})
