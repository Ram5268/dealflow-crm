import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import { LeadsView } from '@/app/leads/LeadsView'
import type { AppliedSort, LeadRow } from '@/lib/leads/list'

// Brief 45 PR B — All leads: with no Smart View and no column sort, the page
// is in the same rank order as every list (CONTRACT §3), with a "#" column
// and data-rank on every row (the post-merge check reads it); ?group=<id>
// filters to one group with a removable "Group: Hot" chip. Smart Views and
// column sorts keep working as before (no rank column). Made-up names only.

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }

const lead = (i: number, rank?: number): LeadRow => ({
  id: `lead_${i}`,
  displayName: `Test Owner ${i}`,
  statusLabel: null,
  priorityScore: 90 - i,
  source: 'import:test',
  address: `${100 + i} Example St`,
  contactCount: 1,
  updatedAt: '2026-10-18T12:00:00.000Z',
  ...(rank !== undefined ? { rank } : {}),
})

const RANKED: AppliedSort = { key: null, dir: 'asc', fromView: false, ranked: true }
const BY_NAME: AppliedSort = { key: 'displayName', dir: 'asc', fromView: false }

function render(props: Partial<Parameters<typeof LeadsView>[0]>): string {
  return renderToStaticMarkup(
    h(AppRouterContext.Provider, { value: router },
      h(TooltipProvider, null,
        h(ToastProvider, null,
          h(LeadsView, {
            rows: [lead(1, 1), lead(2, 2), lead(3, 3)],
            total: 3,
            page: 1,
            pageSize: 100,
            sort: RANKED,
            q: '',
            viewId: '',
            views: [],
            ...props,
          } as Parameters<typeof LeadsView>[0])))),
  )
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

describe('All leads in rank order', () => {
  it('has a # column and data-rank on every row, 1..n', () => {
    const html = render({})
    expect(html).toMatch(/<th[^>]*>#<\/th>/)
    const ranks = [...html.matchAll(/<tr[^>]*\sdata-rank="(\d+)"/g)].map((m) => Number(m[1]))
    expect(ranks).toEqual([1, 2, 3])
    expect((html.match(/data-rank=/g) ?? []).length).toBe(3)
  })

  it('page 2 keeps the global numbers', () => {
    const html = render({ rows: [lead(101, 101), lead(102, 102)], page: 2, total: 102 })
    expect([...html.matchAll(/data-rank="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([101, 102])
  })

  it('a column sort shows the grid exactly as before (no # column, no data-rank) and a way back to ranked order', () => {
    const html = render({ rows: [lead(1), lead(2)], sort: BY_NAME })
    expect(html).not.toContain('data-rank')
    expect(html).not.toMatch(/<th[^>]*>#<\/th>/)
    expect(text(html)).toContain('Ranked order')
  })

  it('a Smart View has no rank column either', () => {
    const html = render({ rows: [lead(1)], sort: { key: 'priorityScore', dir: 'desc', fromView: true }, viewId: 'v1', views: [{ id: 'v1', name: 'DealFlow priority' }] })
    expect(html).not.toContain('data-rank')
  })
})

describe('?group=<id>', () => {
  it('shows a removable "Group: Hot" chip with the group color', () => {
    const html = render({ group: { id: 'g1', name: 'Hot', color: 'red' } })
    expect(text(html)).toContain('Group: Hot')
    expect(html).toContain('aria-label="Remove the group filter"')
    expect(html).toMatch(/bg-group-red/)
  })

  it('"In no group" for group=none', () => {
    expect(text(render({ group: { id: 'none', name: 'In no group', color: 'gray' } }))).toContain('In no group')
  })

  it('a group that no longer exists says so and shows everyone', () => {
    const t = text(render({ groupError: 'That group no longer exists. Showing all leads.' }))
    expect(t).toContain('That group no longer exists. Showing all leads.')
  })
})
