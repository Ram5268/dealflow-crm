import { describe, it, expect } from 'vitest'
import { compile, NOT_A_TIMELINE_NOTE, type CompileContext } from '@/lib/core-data/query-dsl/compiler'
import { GROUP_ACTIVITY_TYPE } from '@/lib/core-data/lists/timeline'
import type { SQuery } from '@/lib/core-data/query-dsl/schema'

// Brief 45 [engineering precaution]: a group label's timeline entry (Activity
// type 'Group') is not activity with the lead, so every `activity` reference in
// a Smart View skips it. Brief 50 PR 4 [engineering precaution]: so is Ryan's
// own edit to a lead (type 'Edit', written by Brief 50 PR 5).
const ctx: CompileContext = { organizationId: 'org_1', customFieldTypes: {} }
const typeIs = (value: string): SQuery => ({
  type: 'field_condition',
  field: { kind: 'regular', table: 'activity', column: 'type' },
  condition: { type: 'text', mode: 'exact', value },
})

describe('compiler — activity skips group-label and edit entries', () => {
  it('excludes exactly the group timeline\'s type and the lead-edit type', () => {
    expect(NOT_A_TIMELINE_NOTE).toBe(`a."type" NOT IN ('${GROUP_ACTIVITY_TYPE}', 'Edit')`)
  })

  it('object_type activity', () => {
    const r = compile({ type: 'object_type', object_type: 'activity' }, ctx)
    expect(r.whereSql).toBe(`EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = lead.id AND ${NOT_A_TIMELINE_NOTE})`)
    expect(r.params).toEqual([])
  })

  it('an activity field condition', () => {
    const r = compile(typeIs('Call'), ctx)
    expect(r.whereSql).toBe(`EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = lead.id AND ${NOT_A_TIMELINE_NOTE} AND (a."type" = $1))`)
    expect(r.params).toEqual(['Call'])
  })

  it('has_related activity', () => {
    const r = compile({ type: 'has_related', object_type: 'activity', query: typeIs('Group') }, ctx)
    expect(r.whereSql).toBe(`EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = lead.id AND ${NOT_A_TIMELINE_NOTE} AND (a."type" = $1))`)
  })

  it('other related objects are unchanged', () => {
    expect(compile({ type: 'object_type', object_type: 'contact' }, ctx).whereSql).toBe('EXISTS (SELECT 1 FROM "Contact" c WHERE c."leadId" = lead.id)')
  })
})
