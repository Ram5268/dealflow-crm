import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import type { GroupChipDTO, RankedPage, RankedRow } from '@/lib/core-data/lists/types'
import { EXPORT_COLUMNS } from '@/lib/core-data/lists/ranked'
import { ListView, ListNotFound, CALL_LIST_LATER } from '@/app/lists/[id]/ListView'
import { listSearchString, parseListSearch } from '@/app/lists/[id]/filters'
import { LIST_CSV_COLUMNS, rowsToCsv, selectedCsvFilename } from '@/app/lists/[id]/csv'
import { keepSelection } from '@/app/lists/[id]/selection'
import { pageParam } from '@/lib/ui/pageParam'
import { MAX_PAGE } from '@/lib/core-data/lists/types'
import { localTimeInfo, rankBadge, rankedHeadline, rankedStamp, sourceLine, RANK_BADGES } from '@/components/lists/format'

// Brief 45 PR B — a list's page (brief §5.4): the header (folder, source,
// "Ranked today at 7:02 am", "Start calling this list" greyed out with the
// calling-off reason), one always-ranked view whose filters keep the global
// rank numbers, the rank-state badges, local time with the calling-hours dot
// (never "OK to call"), and the archived banner. Made-up names only.

const WED_NOON_NY = new Date('2026-10-14T16:00:00.000Z')
const SUN_NOON_NY = new Date('2026-10-18T16:00:00.000Z')
const RANKED_TODAY = '2026-10-18T11:02:00.000Z' // 7:02 am in New York, the Sunday
const RANKED_WED = '2026-10-14T11:02:00.000Z' // 7:02 am in New York, the day the page is drawn

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }

const HOT: GroupChipDTO = { id: 'g1', name: 'Hot', color: 'red' }
const NURTURE: GroupChipDTO = { id: 'g3', name: 'Nurture', color: 'blue' }

function row(rank: number, patch: Partial<RankedRow> = {}): RankedRow {
  return {
    rank,
    leadId: `lead_${rank}`,
    displayName: `Test Owner ${rank}`,
    address: `${100 + rank} Example St`,
    priorityScore: 80,
    topMatchFit: 85,
    rankState: 'ranked',
    notRankedReason: null,
    whyNow: 'Right neighborhood, price fits budget',
    bestBuyer: { name: 'Sample Buyer Agent', score: 91, isTestData: true },
    groups: [],
    attempts: 2,
    lastResult: 'Left Message',
    timezone: 'America/New_York',
    calledToday: false,
    addedAt: '2026-10-18T14:00:00.000Z',
    ...patch,
  }
}

function page(patch: Partial<RankedPage> = {}, listPatch: Partial<NonNullable<RankedPage['list']>> = {}): RankedPage {
  return {
    list: {
      id: 'l1', name: 'Expireds – Oct 2026', folderId: 'f1', folderName: 'Expireds', source: 'upload:imp_1', sortOrder: 0,
      archivedAt: null, memberCount: 412, createdAt: '2026-10-18T14:00:00.000Z', uploadedAt: '2026-10-18T13:55:00.000Z',
      ...listPatch,
    },
    total: 412,
    memberCount: 412,
    page: 2,
    pageSize: 100,
    rankedAt: RANKED_WED,
    callingOffReason: 'Calling is off',
    callingWindows: {
      'America/New_York': { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: false },
      'America/Chicago': { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: true },
    },
    rows: [
      row(101, { groups: [HOT, NURTURE] }),
      row(102, { rankState: 'scoring', priorityScore: null, topMatchFit: null, whyNow: null, bestBuyer: null, timezone: 'America/Chicago' }),
      row(103, { rankState: 'not_ranked', notRankedReason: 'no_match', priorityScore: null, whyNow: null, bestBuyer: null }),
      row(104, { rankState: 'not_ranked', notRankedReason: 'no_mojo_id', priorityScore: null, whyNow: null, bestBuyer: null, timezone: null, lastResult: null, attempts: 0 }),
    ],
    ...patch,
  }
}

function render(data: RankedPage, opts: { now?: Date | null; filters?: Parameters<typeof ListView>[0]['filters'] } = {}): string {
  return renderToStaticMarkup(
    h(AppRouterContext.Provider, { value: router },
      h(TooltipProvider, null,
        h(ToastProvider, null,
          h(ListView, {
            data,
            groups: [HOT, { id: 'g2', name: 'Appointment Set', color: 'green' }, NURTURE],
            filters: opts.filters ?? {},
            now: opts.now === undefined ? WED_NOON_NY.toISOString() : opts.now?.toISOString(),
          })))),
  )
}

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

/** The opening tag of the first <button> or <a> whose own text contains `label`. */
function control(html: string, label: string): string {
  const m = new RegExp(`<(button|a)([^>]*)>(?:(?!</(?:button|a)>)[\\s\\S])*${label}(?:(?!</(?:button|a)>)[\\s\\S])*</(?:button|a)>`).exec(html)
  expect(m, `a control labelled "${label}"`).not.toBeNull()
  return m![2]
}

/** The text of the element with this id. */
function byId(html: string, id: string): string {
  const m = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>([^<]*)<`).exec(html)
  return decode(m?.[1] ?? '')
}

describe('list page header', () => {
  it('shows the folder, the name, the source and the ranked stamp', () => {
    const t = text(render(page()))
    expect(t).toContain('Expireds')
    expect(t).toContain('Expireds – Oct 2026')
    expect(t).toContain('Uploaded Oct 18 · 412 people')
    expect(t).toContain('Ranked today at 7:02 am')
  })

  it('a list made by hand says so', () => {
    const t = text(render(page({}, { source: 'manual', uploadedAt: undefined, folderId: null, folderName: null, memberCount: 41 })))
    expect(t).toContain('Created by you · 41 people')
    expect(t).toContain('No folder')
  })

  it('"Start calling this list" is greyed out with the calling-off reason while calling is off', () => {
    const html = render(page())
    const tag = control(html, 'Start calling this list')
    expect(tag).toMatch(/\sdisabled=""/)
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1]
    expect(describedBy).toBeTruthy()
    expect(byId(html, describedBy!)).toBe('Calling is off')
  })

  it('while calling is on it is still greyed out: calling a whole list comes later (brief §5.10), never the plain dialer', () => {
    const html = render(page({ callingOffReason: null }))
    const tag = control(html, 'Start calling this list')
    expect(tag).toMatch(/\sdisabled=""/)
    expect(tag).not.toContain('href=')
    expect(html).not.toContain('href="/dialer"')
    expect(byId(html, /aria-describedby="([^"]+)"/.exec(tag)![1])).toBe(CALL_LIST_LATER)
    expect(CALL_LIST_LATER).toBe('Calling a whole list comes in a later update.')
  })

  it('an archived list says so, with Unarchive', () => {
    const t = text(render(page({}, { archivedAt: '2026-10-17T12:00:00.000Z' })))
    expect(t).toContain('This list is archived')
    expect(t).toContain('Unarchive')
    expect(text(render(page()))).not.toContain('This list is archived')
  })
})

describe('the ranked table', () => {
  it('every row carries its global rank number (data-rank), in rank order', () => {
    const html = render(page())
    const ranks = [...html.matchAll(/<tr[^>]*\sdata-rank="(\d+)"/g)].map((m) => Number(m[1]))
    expect(ranks).toEqual([101, 102, 103, 104])
    expect((html.match(/data-rank=/g) ?? []).length).toBe(4)
  })

  it('with a filter, each row keeps its place in the whole list (gaps in the numbers, never 1, 2, 3)', () => {
    const html = render(page({ total: 3, page: 1, rows: [row(3), row(17), row(42)] }), { filters: { strongBuyer: true } })
    const rows = [...html.matchAll(/<tr[^>]*\sdata-rank="(\d+)"[^>]*>(?:(?!<\/tr>)[\s\S])*?<\/td><td[^>]*><span[^>]*>([\d,]+)<\/span>/g)]
    expect(rows.map((m) => Number(m[1]))).toEqual([3, 17, 42])
    // The visible # column says the same as data-rank.
    expect(rows.map((m) => m[2])).toEqual(['3', '17', '42'])
  })

  it('rows show name and property, why now, best buyer, group badges, attempts and last result', () => {
    const html = render(page())
    const t = text(html)
    expect(t).toContain('Test Owner 101')
    expect(t).toContain('201 Example St')
    expect(t).toContain('Right neighborhood, price fits budget')
    expect(t).toContain('Sample Buyer Agent')
    expect(t).toContain('Left Message')
    expect(html).toContain('href="/leads/lead_101"')
    // Group badges in sidebar order, with their color tokens.
    expect(t.indexOf(' Hot ')).toBeLessThan(t.indexOf(' Nurture '))
    expect(html).toMatch(/class="[^"]*bg-group-red-subtle[^"]*"[^>]*>[\s\S]*?Hot/)
  })

  it('rank-state badges in plain English', () => {
    const t = text(render(page()))
    expect(t).toContain('scoring…')
    expect(t).toContain('not ranked: no buyer match yet')
    expect(t).toContain('not ranked: no Mojo ID')
    expect(rankBadge({ rankState: 'ranked', notRankedReason: null })).toBeNull()
    expect(rankBadge({ rankState: 'scoring', notRankedReason: null })).toEqual(RANK_BADGES.scoring)
    for (const b of Object.values(RANK_BADGES)) expect(b.help.length).toBeGreaterThan(30)
  })

  it('local time with the calling-hours dot: never "OK to call", and "(not confirmed yet)" while unconfirmed', () => {
    const html = decode(render(page()))
    expect(html).not.toMatch(/ok to call/i)
    expect(html).toContain('12:00 pm')
    expect(html).toContain('Inside calling hours (not confirmed yet)')
    expect(html).toContain('11:00 am')
    expect(html).toContain('Inside calling hours"') // Chicago's window is confirmed
    const sunday = decode(render(page(), { now: SUN_NOON_NY }))
    expect(sunday).toContain('Outside calling hours (not confirmed yet)')
  })

  it('before the browser clock is read, it shows only the zone (no hydration guess)', () => {
    const html = decode(render(page(), { now: null }))
    expect(html).not.toMatch(/calling hours/)
    expect(text(html)).toContain('Eastern')
  })

  it('100 per page with the count of the whole list', () => {
    const t = text(render(page()))
    expect(t).toContain('of 412')
    expect(t).toContain('Page 2 of 5')
  })

  it('an empty list and a filter that matches nobody say so plainly', () => {
    const empty = text(render(page({ total: 0, memberCount: 0, page: 1, rows: [] }, { memberCount: 0 })))
    expect(empty).toContain('No one is on this list yet.')
    const none = text(render(page({ total: 0, page: 1, rows: [] }), { filters: { q: 'nobody' } }))
    expect(none).toContain('No one on this list matches these filters.')
    expect(none).toContain('Clear filters')
  })
})

describe('filters', () => {
  it('"Called today" is greyed out with the reason while calling is off', () => {
    const html = render(page())
    const tag = control(html, 'Called today')
    expect(tag).toMatch(/\sdisabled=""/)
    expect(byId(html, /aria-describedby="([^"]+)"/.exec(tag)![1])).toBe('Calling is off')
    expect(control(render(page({ callingOffReason: null })), 'Called today')).not.toMatch(/\sdisabled=""/)
  })

  it('"Has a strong buyer" is a toggle; search, group and borough are there', () => {
    const html = render(page(), { filters: { strongBuyer: true, q: 'Owner' } })
    expect(control(html, 'Has a strong buyer')).toContain('aria-pressed="true"')
    expect(html).toMatch(/<input[^>]*value="Owner"/)
    expect(control(render(page()), 'Has a strong buyer')).toContain('aria-pressed="false"')
  })

  it('Export CSV downloads the list in rank order with the same filters', () => {
    const html = decode(render(page(), { filters: { group: 'g1', borough: 'Brooklyn' } }))
    expect(html).toMatch(/href="\/api\/core-data\/lists\/l1\/export\?group=g1&borough=Brooklyn"/)
  })

  it('parse the URL: tolerant, and "called today" only counts while calling is on', () => {
    expect(parseListSearch({ q: ' smith ', group: 'g1', strongBuyer: '1', calledToday: '1', borough: 'brooklyn', page: '3' }, { callingOn: false }))
      .toEqual({ page: 3, filters: { q: 'smith', group: 'g1', strongBuyer: true, borough: 'Brooklyn' } })
    expect(parseListSearch({ calledToday: '1' }, { callingOn: true })).toEqual({ page: 1, filters: { calledToday: true } })
    expect(parseListSearch({ borough: 'Atlantis', page: 'x', strongBuyer: '0' }, { callingOn: false })).toEqual({ page: 1, filters: {} })
  })

  it('a huge page number never reaches the query: past MAX_PAGE (or 20 digits) is page 1', () => {
    expect(parseListSearch({ page: '12345678901234567890' }, { callingOn: false }).page).toBe(1)
    expect(parseListSearch({ page: '1000000' }, { callingOn: false }).page).toBe(1_000_000)
    expect(parseListSearch({ page: '1000001' }, { callingOn: false }).page).toBe(1)
    expect(parseListSearch({ page: '-3' }, { callingOn: false }).page).toBe(1)
    expect(parseListSearch({ page: ['4', '5'] }, { callingOn: false }).page).toBe(4)
  })

  it('the Leads page reads ?page= the same way', () => {
    expect(pageParam('12345678901234567890')).toBe(1)
    expect(pageParam('2')).toBe(2)
    expect(pageParam(String(MAX_PAGE))).toBe(MAX_PAGE)
    expect(pageParam(String(MAX_PAGE + 1))).toBe(1)
    expect(pageParam(undefined)).toBe(1)
    expect(pageParam('abc')).toBe(1)
    expect(pageParam('0')).toBe(1)
  })

  it('write the URL: only what is set, page 1 left out', () => {
    expect(listSearchString({ q: 'smith', group: 'g1', strongBuyer: true, borough: 'Brooklyn' }, 3))
      .toBe('?q=smith&group=g1&strongBuyer=1&borough=Brooklyn&page=3')
    expect(listSearchString({}, 1)).toBe('')
    expect(listSearchString({ calledToday: true })).toBe('?calledToday=1')
  })
})

describe('what stays picked when the rows reload', () => {
  const rows = (...ids: string[]) => ids.map((leadId) => ({ leadId }))

  it('a refresh of the same view (a sidebar or chip change) keeps everyone still on the page', () => {
    const picked = new Set(['a', 'b', 'c'])
    expect([...keepSelection(picked, rows('a', 'b', 'c', 'd'), false)]).toEqual(['a', 'b', 'c'])
    // Nothing changed: the very same Set comes back (no needless re-render).
    expect(keepSelection(picked, rows('a', 'b', 'c', 'd'), false)).toBe(picked)
  })

  it('someone who left the page (taken off the list, say) drops out of the selection', () => {
    expect([...keepSelection(new Set(['a', 'b', 'c']), rows('a', 'c'), false)]).toEqual(['a', 'c'])
  })

  it('a new search, filter or page starts with nothing picked', () => {
    expect(keepSelection(new Set(['a', 'b']), rows('a', 'b'), true).size).toBe(0)
    const none = new Set<string>()
    expect(keepSelection(none, rows('a'), true)).toBe(none)
  })
})

describe('Export CSV of selected rows', () => {
  it('names the file with the New York date, like the server export', () => {
    // 10 pm in New York on Oct 18 is already Oct 19 in UTC.
    expect(selectedCsvFilename('Expireds – Oct 2026', new Date('2026-10-19T02:00:00.000Z'))).toBe('Expireds-Oct-2026-selected-2026-10-18.csv')
    expect(selectedCsvFilename('Referrals', new Date('2026-10-18T16:00:00.000Z'))).toBe('Referrals-selected-2026-10-18.csv')
  })

  it('uses the same columns as the server export (no phones or emails)', () => {
    expect([...LIST_CSV_COLUMNS]).toEqual([...EXPORT_COLUMNS])
    const csv = rowsToCsv(page().rows.slice(0, 1).map((r) => ({ ...r, groups: [HOT] })))
    expect(csv.split('\n')).toEqual([
      'Rank,Name,Address,Priority,Match fit,Why now,Best buyer,Groups,Attempts,Last result,Timezone',
      '101,Test Owner 101,201 Example St,80,85,"Right neighborhood, price fits budget",Sample Buyer Agent,Hot,2,Left Message,Eastern',
    ])
  })
})

describe('display helpers', () => {
  const now = SUN_NOON_NY
  it('ranked stamps in New York time', () => {
    expect(rankedHeadline(RANKED_TODAY, now)).toBe('Ranked today at 7:02 am')
    expect(rankedHeadline('2026-10-17T11:02:00.000Z', now)).toBe('Ranked Oct 17 at 7:02 am')
    expect(rankedHeadline(null, now)).toBe('Not ranked yet')
    expect(rankedStamp(RANKED_TODAY, now)).toBe('ranked 7:02')
    expect(rankedStamp('2026-10-17T11:02:00.000Z', now)).toBe('ranked Oct 17, 7:02')
    expect(rankedStamp(null, now)).toBeNull()
  })

  it('source lines', () => {
    const base = { createdAt: '2026-10-18T14:00:00.000Z', memberCount: 412 }
    expect(sourceLine({ ...base, source: 'upload:imp_1', uploadedAt: '2026-10-18T13:55:00.000Z' })).toBe('Uploaded Oct 18 · 412 people')
    expect(sourceLine({ ...base, source: 'upload:gone' })).toBe('Uploaded Oct 18 · 412 people')
    expect(sourceLine({ ...base, source: 'manual', memberCount: 1 })).toBe('Created by you · 1 person')
  })

  it('local time and the calling-hours dot', () => {
    const ny = { earliestHour: 9, latestHour: 20, allowedDaysOfWeek: [1, 2, 3, 4, 5], confirmed: false }
    expect(localTimeInfo('America/New_York', ny, WED_NOON_NY)).toEqual({
      time: '12:00 pm', zone: 'Eastern', inside: true, label: 'Inside calling hours (not confirmed yet)',
    })
    // 8:00 pm is outside (the window ends at 20:00).
    expect(localTimeInfo('America/New_York', ny, new Date('2026-10-15T00:00:00.000Z'))?.inside).toBe(false)
    expect(localTimeInfo('America/New_York', { ...ny, confirmed: true }, SUN_NOON_NY)?.label).toBe('Outside calling hours')
    expect(localTimeInfo(null, ny, WED_NOON_NY)).toBeNull()
    expect(localTimeInfo('Not/AZone', ny, WED_NOON_NY)).toBeNull()
  })
})

describe('a list that does not exist', () => {
  it('says so plainly and points back to All leads (nobody was deleted)', () => {
    const html = renderToStaticMarkup(h(ListNotFound))
    const t = text(html)
    expect(t).toContain('This list doesn’t exist')
    expect(t).toMatch(/still in All leads/)
    expect(html).toContain('href="/leads"')
  })
})
