import { describe, it, expect } from 'vitest'
import { createElement as h, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { GroupChipsView } from '@/components/lists/GroupChips'
import { LeadListChips } from '@/components/lists/LeadListChips'

// Brief 45 PR C — what the contact card shows [brief §5.3]: a "Groups:" row
// with every group as a chip in sidebar order plus "+", a "Lists:" row linking
// to each of the lead's lists, and group changes on the timeline ("Added to
// Hot" / "Removed from Nurture", tested in activity-timeline-group.test.ts).
// The post-merge production check reads data-testid="group-chips",
// data-group-id and data-testid="group-chip-add". Made-up names only.

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

const render = (el: ReactElement) => renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, el))
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

/** Each chip's opening tag, in order. */
const chipTags = (html: string) => [...html.matchAll(/<button[^>]*data-group-id="[^"]*"[^>]*>/g)].map((m) => m[0])
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

const GROUPS = [
  { id: 'grp_hot', name: 'Hot', color: 'red' as const },
  { id: 'grp_appt', name: 'Appointment Set', color: 'green' as const },
  { id: 'grp_nurture', name: 'Nurture', color: 'blue' as const },
]

describe('the lead page Groups row', () => {
  it('with no groups yet: only the "+" chip', () => {
    const html = render(h(GroupChipsView, { groups: [], lit: [], label: 'Groups:', hotkeys: true }))
    expect(count(html, /data-testid="group-chips"/g)).toBe(1)
    expect(count(html, /data-testid="group-chip-add"/g)).toBe(1)
    expect(count(html, /data-group-id=/g)).toBe(0)
    expect(text(html)).toContain('Groups:')
    expect(text(html)).toContain('New group')
  })

  it('with groups: every group as a chip in sidebar order, the lit one pressed, then "+"', () => {
    const html = render(h(GroupChipsView, { groups: GROUPS, lit: ['grp_appt'], label: 'Groups:', hotkeys: true }))
    const tags = chipTags(html)
    expect(tags.map((t) => attr(t, 'data-group-id'))).toEqual(['grp_hot', 'grp_appt', 'grp_nurture'])
    expect(tags.map((t) => attr(t, 'aria-pressed'))).toEqual(['false', 'true', 'false'])
    expect(tags.map((t) => attr(t, 'aria-keyshortcuts'))).toEqual(['1', '2', '3'])
    expect(text(html)).toMatch(/Groups: .*Hot.*Appointment Set.*Nurture/)
    expect(count(html, /data-testid="group-chip-add"/g)).toBe(1)
    // "+" comes after the chips
    expect(html.indexOf('data-testid="group-chip-add"')).toBeGreaterThan(html.lastIndexOf('data-group-id='))
  })

  it('only the first nine chips get a key', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `grp_${i + 1}`, name: `Group ${i + 1}`, color: 'gray' as const }))
    const tags = chipTags(render(h(GroupChipsView, { groups: ten, lit: [], hotkeys: true })))
    expect(tags.map((t) => attr(t, 'aria-keyshortcuts'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', undefined])
  })

  it('without hotkeys (e.g. Pipeline cards) no keys are advertised', () => {
    const tags = chipTags(render(h(GroupChipsView, { groups: GROUPS, lit: [] })))
    expect(tags.map((t) => attr(t, 'aria-keyshortcuts'))).toEqual([undefined, undefined, undefined])
  })

  it('compact (list rows): small chips, no label', () => {
    const html = render(h(GroupChipsView, { groups: GROUPS, lit: ['grp_hot'], compact: true }))
    expect(html).toMatch(/data-testid="group-chips"[^>]*data-size="compact"|data-size="compact"[^>]*data-testid="group-chips"/)
    expect(text(html)).not.toContain('Groups:')
    expect(chipTags(html)).toHaveLength(3)
  })

  it('while the groups load: no chips yet, "+" still there; a load error says so with Try again', () => {
    const loading = render(h(GroupChipsView, { groups: null, lit: ['grp_hot'], label: 'Groups:' }))
    expect(count(loading, /data-group-id=/g)).toBe(0)
    expect(count(loading, /data-testid="group-chip-add"/g)).toBe(1)
    expect(text(loading)).toContain('Loading groups')

    const failed = render(h(GroupChipsView, { groups: null, lit: [], label: 'Groups:', loadError: 'Your lists could not be loaded.' }))
    expect(text(failed)).toContain('Your lists could not be loaded.')
    expect(text(failed)).toContain('Try again')
  })
})

describe('the lead page Lists row', () => {
  it('not on any list yet', () => {
    const html = render(h(LeadListChips, { lists: [] }))
    expect(text(html)).toBe('Lists: Not on any list yet')
  })

  it('one chip per list, linking to it, in sidebar order', () => {
    const html = render(
      h(LeadListChips, {
        lists: [
          { id: 'list_1', name: 'Expireds – Oct 2026', folderName: 'Expireds' },
          { id: 'list_2', name: 'Referrals', folderName: null },
        ],
      }),
    )
    const links = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], text(m[2])])
    expect(links).toEqual([
      ['/lists/list_1', 'Expireds – Oct 2026'],
      ['/lists/list_2', 'Referrals'],
    ])
    expect(decode(html)).toContain('title="In the folder Expireds"')
    expect(text(html)).toMatch(/^Lists:/)
  })
})
