import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import type { GroupChipDTO, RankedPage, RankedRow } from '@/lib/core-data/lists/types'
import { ListView } from '@/app/lists/[id]/ListView'

// Brief 50 PR 7 (open item 6.12): a list's table fits its page instead of
// scrolling sideways (Brief 45 measured 228 px too wide at 1280 px, 68 px at
// 1440 px, more with the value column, and far more on a phone). The table
// box is a CSS size container; as it gets narrower, the less-used columns
// fold into a neighbouring cell instead of disappearing, so every fact is
// still on the row:
//   ≥ 1320 px  every column;
//   < 1320 px  local time goes under the calls;
//   < 1200 px  the best buyer goes under "why now";
//   < 1000 px  our value and the calls (with local time) go under the name;
//   <  768 px  (phones) "why now" (with the best buyer) and the groups go
//              under the name too: the row is #, name and the facts beneath.
// Attempts and last result are one "Calls" column. The real widths are
// checked in a browser (logs/pr7-width-*.log); this pins the rules. Made-up
// names only.

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
const HOT: GroupChipDTO = { id: 'g1', name: 'Hot', color: 'red' }
const NURTURE: GroupChipDTO = { id: 'g3', name: 'Nurture', color: 'blue' }

function row(rank: number, patch: Partial<RankedRow> = {}): RankedRow {
  return {
    rank, leadId: `lead_${rank}`, displayName: `Test Owner ${rank}`, address: `${100 + rank} Example St`,
    priorityScore: 80, topMatchFit: 85, rankState: 'ranked', notRankedReason: null,
    whyNow: 'Right neighborhood, price fits budget', bestBuyer: { name: 'Sample Buyer Agent', score: 91, isTestData: true },
    groups: [HOT, NURTURE], attempts: 2, lastResult: 'Left Message', timezone: 'America/New_York', calledToday: false,
    addedAt: '2026-10-18T14:00:00.000Z', value: { value: 1_830_000, low: 1_540_000, high: 2_120_000 },
    ...patch,
  }
}

function render(rows: RankedRow[]): string {
  const data: RankedPage = {
    list: {
      id: 'l1', name: 'Expireds – Oct 2026', folderId: null, folderName: null, source: 'manual', sortOrder: 0,
      archivedAt: null, memberCount: rows.length, createdAt: '2026-10-18T14:00:00.000Z', uploadedAt: null,
    },
    total: rows.length, memberCount: rows.length, page: 1, pageSize: 100, rankedAt: '2026-10-14T11:02:00.000Z',
    callingOffReason: 'Calling is off',
    callingWindows: { 'America/New_York': { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: false } },
    hasValues: true, rows,
  }
  return renderToStaticMarkup(
    h(AppRouterContext.Provider, { value: router },
      h(TooltipProvider, null,
        h(ToastProvider, null,
          h(ListView, { data, groups: [HOT, NURTURE], filters: {}, now: '2026-10-14T16:00:00.000Z' })))),
  )
}

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every header cell: its text and its classes. */
function headers(html: string): { label: string; cls: string[] }[] {
  const thead = /<thead[\s\S]*?<\/thead>/.exec(html)![0]
  return [...thead.matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)].map((m) => ({
    label: text(m[2]),
    cls: (/class="([^"]*)"/.exec(m[1])?.[1] ?? '').split(/\s+/),
  }))
}

/** The cells of the row with this rank, in column order. */
function cells(html: string, rank: number): { html: string; cls: string[] }[] {
  const tr = new RegExp(`<tr[^>]*data-rank="${rank}"[^>]*>([\\s\\S]*?)</tr>`).exec(html)![1]
  return [...tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>(?=<td|$)/g)].map((m) => ({
    html: m[2],
    cls: (/class="([^"]*)"/.exec(m[1])?.[1] ?? '').split(/\s+/),
  }))
}

/** The text of every element carrying the class `cls` inside `html`. */
function folded(html: string, cls: string): string[] {
  const out: string[] = []
  const open = new RegExp(`<([a-z]+)[^>]*class="[^"]*(?<=["\\s])${esc(cls)}(?=["\\s])[^"]*"[^>]*>`, 'g')
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const tag = m[1]
    const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g')
    re.lastIndex = m.index
    let depth = 0
    for (let n = re.exec(html); n; n = re.exec(html)) {
      depth += n[0].startsWith('</') ? -1 : 1
      if (depth === 0) {
        out.push(text(html.slice(m.index, n.index + n[0].length)))
        break
      }
    }
  }
  return out
}

const SHOW = {
  always: null,
  phone: 'hidden @min-[48rem]:table-cell',
  narrow: 'hidden @min-[62.5rem]:table-cell',
  medium: 'hidden @min-[75rem]:table-cell',
  wide: 'hidden @min-[82.5rem]:table-cell',
} as const

describe('the list table fits its page [open item 6.12]', () => {
  const html = render([row(101), row(102, { rankState: 'scoring', priorityScore: null, whyNow: null, bestBuyer: null, value: null, groups: [], attempts: 0, lastResult: null })])

  it('the table sits in a size container, so the columns follow the room the table has (not the window)', () => {
    expect(html).toMatch(/<div class="[^"]*@container[^"]*"[^>]*>\s*<div class="overflow-x-auto/)
  })

  it('which columns show at which width; attempts and last result are one "Calls" column', () => {
    const want: [string, keyof typeof SHOW][] = [
      ['#', 'always'], ['Name and property', 'always'], ['Our value', 'narrow'], ['Why now', 'phone'],
      ['Best buyer', 'medium'], ['Groups', 'phone'], ['Calls', 'narrow'], ['Local time', 'wide'],
    ]
    const hs = headers(html).filter((x) => x.label !== '') // the select-all checkbox column has no label
    expect(hs.map((x) => x.label)).toEqual(want.map(([label]) => label))
    for (const [label, tier] of want) {
      const cls = hs.find((x) => x.label === label)!.cls
      if (SHOW[tier] === null) expect(cls, label).not.toContain('hidden')
      else for (const c of SHOW[tier]!.split(' ')) expect(cls, label).toContain(c)
    }
    // Every row's cells carry their column's classes.
    const row101 = cells(html, 101).slice(1) // after the checkbox
    expect(row101).toHaveLength(want.length)
    want.forEach(([label, tier], i) => {
      if (SHOW[tier] === null) expect(row101[i].cls, label).not.toContain('hidden')
      else for (const c of SHOW[tier]!.split(' ')) expect(row101[i].cls, label).toContain(c)
    })
  })

  it('a folded column\'s facts show in its neighbour, only while its own column is hidden', () => {
    const [, , name, , whyNow, , , calls] = cells(html, 101)
    // Under the name (< 1000 px): our value, then the calls with local time.
    expect(folded(name.html, '@min-[62.5rem]:hidden')).toEqual(['$1.83M · likely $1.54M–$2.12M', '2 calls · Left Message · 12:00 pm Eastern'])
    // Under the name (phones): why now with the best buyer, and the groups (read-only there).
    expect(folded(name.html, '@min-[48rem]:hidden')).toEqual(['Right neighborhood, price fits budget Best buyer: Sample Buyer Agent 91 Test', 'Hot Nurture'])
    // Under "why now" (< 1200 px): the best buyer.
    expect(folded(whyNow.html, '@min-[75rem]:hidden')).toEqual(['Best buyer: Sample Buyer Agent 91 Test'])
    // Under the calls (< 1320 px): local time.
    expect(folded(calls.html, '@min-[82.5rem]:hidden')).toEqual(['12:00 pm Eastern'])
    expect(text(calls.html)).toMatch(/^2 calls · Left Message/)
  })

  it('a row with little to say folds only what it has', () => {
    const [, , name, , whyNow, , , calls] = cells(html, 102)
    expect(folded(name.html, '@min-[62.5rem]:hidden')).toEqual(['No calls yet · 12:00 pm Eastern'])
    expect(folded(name.html, '@min-[48rem]:hidden')).toEqual(['scoring…'])
    expect(folded(whyNow.html, '@min-[75rem]:hidden')).toEqual([])
    expect(text(calls.html)).toMatch(/^No calls yet/)
  })

  it('cells that could push the table wide are capped: names and buyers truncate, long reasons wrap', () => {
    const [, , name, , whyNow, buyer] = cells(html, 101)
    expect(name.html).toMatch(/max-w-\[13rem\]/)
    expect(whyNow.html).toMatch(/line-clamp-2/)
    expect(buyer.html).toMatch(/w-\[11rem\]/)
    expect(buyer.html).toMatch(/truncate/)
  })
})
