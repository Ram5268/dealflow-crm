import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui'
import type { FolderDTO, GroupDTO, ListDTO, SidebarData } from '@/lib/core-data/lists/types'
import { SidebarTree, SidebarUiContext, inertSidebarUi, type SidebarTreeProps, type SidebarUi } from '@/components/lists/sidebar/SidebarTree'
import { LIST_PALETTE_COMMANDS, paletteGroupEntries, paletteListEntries } from '@/components/lists/sidebar/palette'
import { SHORTCUT_GROUPS } from '@/components/shell/ShortcutsSheet'

// Brief 45 PR B — the Mojo-style left sidebar (brief §5.2): All leads with its
// live count and "ranked 7:02" stamp, LISTS (folders holding lists, lists
// outside folders, the archived section), GROUPS with their colors and counts,
// and the two empty-state sentences exactly. Made-up names only.

const NOW = new Date('2026-10-18T16:00:00.000Z') // noon in New York
const RANKED_TODAY = '2026-10-18T11:02:00.000Z' // 7:02 am in New York

const folder = (id: string, name: string, sortOrder: number, listCount: number, archivedListCount = 0): FolderDTO => ({
  id, name, sortOrder, listCount, archivedListCount,
})
const list = (id: string, name: string, folderId: string | null, memberCount: number, archivedAt: string | null = null): ListDTO => ({
  id, name, folderId, source: 'manual', sortOrder: 0, archivedAt, memberCount, createdAt: '2026-10-01T12:00:00.000Z',
})
const group = (id: string, name: string, color: GroupDTO['color'], memberCount: number): GroupDTO => ({
  id, name, color, sortOrder: 0, memberCount,
})

function populated(): SidebarData {
  return {
    allLeads: { count: 1489, rankedAt: RANKED_TODAY },
    folders: [folder('f1', 'Expireds', 0, 2), folder('f2', 'Off-market', 1, 1, 1)],
    lists: [
      list('l1', 'Expireds – Oct 2026', 'f1', 412),
      list('l2', 'Expireds – Sep 2026', 'f1', 0),
      list('l3', 'Brownstones likely to sell', 'f2', 1102),
      list('l4', 'Referrals', null, 41),
    ],
    archivedCount: 2,
    groups: [group('g1', 'Hot', 'red', 14), group('g2', 'Appointment Set', 'green', 3), group('g3', 'Nurture', 'blue', 96)],
    workflows: [],
  }
}

const EMPTY: SidebarData = {
  allLeads: { count: 1489, rankedAt: RANKED_TODAY },
  folders: [], lists: [], archivedCount: 0, groups: [], workflows: [],
}

const LISTS_EMPTY = 'No lists yet. Upload a spreadsheet or create a list.'
const GROUPS_EMPTY = 'No groups yet. Create groups like Hot or Nurture to sort people as you talk to them.'

function render(props: Partial<SidebarTreeProps> & { data: SidebarData | null }, ui: Partial<SidebarUi> = {}): string {
  return renderToStaticMarkup(
    h(TooltipProvider, null,
      h(SidebarUiContext.Provider, { value: { ...inertSidebarUi, ...ui } },
        h(SidebarTree, { now: NOW, ...props } as SidebarTreeProps))),
  )
}

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

/** The opening tag and inner text of the first <a> pointing at href. */
function link(html: string, href: string): { tag: string; text: string } {
  const esc = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&(?:amp;)?')
  const m = new RegExp(`<a([^>]*href="${esc}"[^>]*)>([\\s\\S]*?)</a>`).exec(html)
  expect(m, `a link to ${href}`).not.toBeNull()
  return { tag: m![1], text: text(m![2]).trim() }
}

describe('the sidebar tree', () => {
  it('All leads: always there, links to /leads, with the live count and the ranked stamp in New York time', () => {
    const html = render({ data: populated() })
    const all = link(html, '/leads')
    expect(all.text).toContain('All leads')
    expect(all.text).toContain('1,489')
    expect(text(html)).toContain('ranked 7:02')
  })

  it('a stamp from an earlier day shows its date', () => {
    const html = render({ data: { ...populated(), allLeads: { count: 5, rankedAt: '2026-10-17T11:02:00.000Z' } } })
    expect(text(html)).toContain('ranked Oct 17, 7:02')
  })

  it('folders hold their lists in order, lists outside folders come after, each with its count', () => {
    const html = render({ data: populated() })
    const t = text(html)
    const order = ['Expireds', 'Expireds – Oct 2026', 'Expireds – Sep 2026', 'Off-market', 'Brownstones likely to sell', 'Referrals']
    const at = order.map((name) => t.indexOf(` ${name} `))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(link(html, '/lists/l1').text).toBe('Expireds – Oct 2026 412')
    expect(link(html, '/lists/l3').text).toBe('Brownstones likely to sell 1,102')
    expect(link(html, '/lists/l4').text).toBe('Referrals 41')
    // Folders are buttons that open and close (no folder inside a folder).
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*>(?:(?!<\/button>)[\s\S])*Expireds/)
  })

  it('a collapsed folder hides its lists (remembered per browser by the caller)', () => {
    const html = render({ data: populated(), collapsedFolderIds: new Set(['f2']) })
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>)[\s\S])*Off-market/)
    expect(html).not.toContain('href="/lists/l3"')
    expect(html).toContain('href="/lists/l1"')
  })

  it('archived lists sit in a collapsible "Archived (n)" section', () => {
    const closed = render({ data: populated() })
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"[^>]*>(?:(?!<\/button>)[\s\S])*Archived \(2\)/)
    expect(closed).not.toContain('href="/lists/a1"')
    const open = render({
      data: populated(),
      archivedOpen: true,
      archivedLists: [list('a1', 'Old expireds', 'f2', 7, '2026-10-10T12:00:00.000Z'), list('a2', 'Old referrals', null, 2, '2026-10-11T12:00:00.000Z')],
    })
    expect(open).toMatch(/<button[^>]*aria-expanded="true"[^>]*>(?:(?!<\/button>)[\s\S])*Archived \(2\)/)
    expect(link(open, '/lists/a1').text).toContain('Old expireds')
    expect(link(open, '/lists/a2').text).toContain('Old referrals')
  })

  it('groups show their color dot and count, and open the Pipeline on that group (PR D)', () => {
    const html = render({ data: populated() })
    const hot = link(html, '/pipeline?groups=g1')
    expect(hot.text).toBe('Hot 14')
    expect(link(html, '/pipeline?groups=g3').text).toBe('Nurture 96')
    // The dot uses the group color tokens (both themes), never a raw color.
    expect(html).toMatch(/href="\/pipeline\?groups=g1"[^>]*>[\s\S]*?class="[^"]*bg-group-red[^"]*"/)
    expect(html).toMatch(/href="\/pipeline\?groups=g2"[^>]*>[\s\S]*?class="[^"]*bg-group-green[^"]*"/)
  })

  it('marks the open list, and the group being viewed', () => {
    const onList = render({ data: populated(), pathname: '/lists/l1' })
    expect(link(onList, '/lists/l1').tag).toContain('aria-current="page"')
    expect(link(onList, '/lists/l4').tag).not.toContain('aria-current')
    const onGroup = render({ data: populated(), pathname: '/pipeline', activeGroupId: 'g2' })
    expect(link(onGroup, '/pipeline?groups=g2').tag).toContain('aria-current="page"')
    expect(link(onGroup, '/pipeline?groups=g1').tag).not.toContain('aria-current')
    expect(link(onGroup, '/leads').tag).not.toContain('aria-current')
  })

  it('every folder, list and group has a keyboard-reachable ⋯ menu button', () => {
    const html = render({ data: populated() })
    for (const name of ['Expireds', 'Expireds – Oct 2026', 'Referrals', 'Hot', 'Nurture']) {
      expect(decode(html)).toContain(`aria-label="More actions for ${name}"`)
    }
    expect(html).toContain('aria-haspopup="menu"')
  })

  it('has + Folder, + List and + Group', () => {
    const html = render({ data: populated() })
    expect(html).toContain('aria-label="New folder"')
    expect(html).toContain('aria-label="New list"')
    expect(html).toContain('aria-label="New group"')
  })

  it('never carries data-rank (the post-merge check counts the rows of the page that do)', () => {
    expect(render({ data: populated(), archivedOpen: true, archivedLists: [] })).not.toContain('data-rank')
  })
})

describe('empty states (exact wording)', () => {
  it('a new CRM: All leads plus both empty-state sentences', () => {
    const t = text(render({ data: EMPTY }))
    expect(t).toContain('All leads')
    expect(t).toContain(LISTS_EMPTY)
    expect(t).toContain(GROUPS_EMPTY)
    expect(t).not.toContain('Archived')
  })

  it('a folder but no lists yet still says there are no lists', () => {
    const t = text(render({ data: { ...EMPTY, folders: [folder('f1', 'Expireds', 0, 0)] } }))
    expect(t).toContain('Expireds')
    expect(t).toContain(LISTS_EMPTY)
  })

  it('only archived lists: no "No lists yet", the Archived section instead', () => {
    const t = text(render({ data: { ...EMPTY, archivedCount: 1 } }))
    expect(t).not.toContain(LISTS_EMPTY)
    expect(t).toContain('Archived (1)')
  })

  it('while loading, it claims nothing is empty', () => {
    const t = text(render({ data: null, loading: true }))
    expect(t).not.toContain(LISTS_EMPTY)
    expect(t).not.toContain(GROUPS_EMPTY)
  })

  it('a failed load says so in plain English, with a way to try again', () => {
    const t = text(render({ data: null, error: 'Your lists could not be loaded.' }))
    expect(t).toContain('Your lists could not be loaded.')
    expect(t).toContain('Try again')
    expect(t).not.toContain(LISTS_EMPTY)
  })
})

describe('inline create and rename', () => {
  it('+ List opens a name box; the API’s refusal shows inline, word for word', () => {
    const msg = 'A list named "Referrals" is already outside folders.'
    const html = render({ data: populated() }, { creating: { kind: 'list', folderId: null }, inlineError: msg })
    expect(html).toMatch(/<input[^>]*placeholder="List name"/)
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/)
    expect(decode(html)).toMatch(new RegExp(`role="alert"[^>]*>${msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`))
  })

  it('a new list inside a folder gets its box inside that folder', () => {
    const html = render({ data: populated() }, { creating: { kind: 'list', folderId: 'f2' } })
    const t = html.indexOf('placeholder="List name"')
    expect(t).toBeGreaterThan(html.indexOf('Brownstones likely to sell'))
    expect(t).toBeLessThan(html.indexOf('Referrals'))
  })

  it('+ Folder and + Group boxes', () => {
    expect(render({ data: EMPTY }, { creating: { kind: 'folder', folderId: null } })).toMatch(/<input[^>]*placeholder="Folder name"/)
    expect(render({ data: EMPTY }, { creating: { kind: 'group', folderId: null } })).toMatch(/<input[^>]*placeholder="Group name"/)
  })

  it('rename turns the row into a box holding the current name', () => {
    const html = render({ data: populated() }, { renaming: { kind: 'group', id: 'g3' } })
    expect(html).toMatch(/<input[^>]*value="Nurture"/)
    expect(html).not.toContain('href="/pipeline?groups=g3"')
  })
})

describe('⌘K: go to a list or a group, and create', () => {
  it('lists every active list with its folder, linking to its page', () => {
    expect(paletteListEntries(populated())).toEqual([
      { id: 'l1', label: 'Expireds – Oct 2026', detail: 'Expireds', count: 412, href: '/lists/l1' },
      { id: 'l2', label: 'Expireds – Sep 2026', detail: 'Expireds', count: 0, href: '/lists/l2' },
      { id: 'l3', label: 'Brownstones likely to sell', detail: 'Off-market', count: 1102, href: '/lists/l3' },
      { id: 'l4', label: 'Referrals', detail: 'No folder', count: 41, href: '/lists/l4' },
    ])
    expect(paletteListEntries(null)).toEqual([])
  })

  it('groups open the Pipeline on that group (PR D; before it, All leads filtered to the group)', () => {
    expect(paletteGroupEntries(populated())).toEqual([
      { id: 'g1', label: 'Hot', color: 'red', count: 14, href: '/pipeline?groups=g1' },
      { id: 'g2', label: 'Appointment Set', color: 'green', count: 3, href: '/pipeline?groups=g2' },
      { id: 'g3', label: 'Nurture', color: 'blue', count: 96, href: '/pipeline?groups=g3' },
    ])
  })

  it('has Go to list…, Go to group…, New list, New folder and New group ("Open Pipeline" is one of the palette\'s own actions)', () => {
    const labels = LIST_PALETTE_COMMANDS.map((c) => c.label)
    expect(labels).toEqual(['Go to list…', 'Go to group…', 'New list', 'New folder', 'New group'])
    expect(labels.join(' ')).not.toMatch(/pipeline/i)
  })
})

describe('ShortcutsSheet', () => {
  it('lists the sidebar keys', () => {
    const items = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => `${i.keys.join('+')} ${i.label}`))
    const has = (keys: string, label: RegExp) => expect(items.some((s) => s.startsWith(`${keys} `) && label.test(s))).toBe(true)
    has('F2', /rename/i)
    has('⇧+F10', /menu/i)
    has('⌥+↑', /move up/i)
    has('⌥+↓', /move down/i)
  })
})
