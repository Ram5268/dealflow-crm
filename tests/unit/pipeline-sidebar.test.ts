import { describe, it, expect } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import type { SidebarData, WorkflowDTO } from '@/lib/core-data/lists/types'
import { SidebarTree, SidebarUiContext, inertSidebarUi, type SidebarTreeProps } from '@/components/lists/sidebar/SidebarTree'
import { groupHref } from '@/components/lists/sidebar/palette'
import { activeSidebarItems } from '@/components/lists/sidebar/active'
import { PipelineView } from '@/app/pipeline/PipelineView'
import { pageData } from './helpers/pipeline-fixtures'

// Brief 45 PR D, integration with PR B's sidebar: a group opens the Pipeline
// on that group; saved workflows are listed under Groups ("Workflows") and
// open their tab; the board's columns and cards carry each group's color.
// Made-up names only.

const NOW = new Date('2026-10-18T16:00:00.000Z')
const wf = (id: string, name: string): WorkflowDTO => ({ id, name, view: 'board', filters: {}, groupIds: [], sort: null })

function data(workflows: WorkflowDTO[]): SidebarData {
  return {
    allLeads: { count: 12, rankedAt: null },
    folders: [],
    lists: [],
    archivedCount: 0,
    groups: [
      { id: 'g1', name: 'Hot', color: 'red', sortOrder: 0, memberCount: 4 },
      { id: 'g2', name: 'Nurture', color: 'green', sortOrder: 1, memberCount: 2 },
    ],
    workflows,
  }
}

const renderTree = (props: Partial<SidebarTreeProps> & { data: SidebarData | null }) =>
  renderToStaticMarkup(
    h(TooltipProvider, null, h(SidebarUiContext.Provider, { value: inertSidebarUi }, h(SidebarTree, { now: NOW, ...props } as SidebarTreeProps))),
  )

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
const linkTag = (html: string, href: string) => {
  const m = new RegExp(`<a[^>]*href="${href.replace(/[?]/g, '\\?')}"[^>]*>`).exec(html)
  expect(m, `a link to ${href}`).not.toBeNull()
  return m![0]
}

describe('the sidebar, with the Pipeline', () => {
  it('a group opens the Pipeline on that group (the sidebar and ⌘K use the same place)', () => {
    expect(groupHref('g1')).toBe('/pipeline?groups=g1')
    expect(groupHref('a b')).toBe('/pipeline?groups=a%20b')
  })

  it('Workflows, under Groups: each saved workflow opens its tab, in order', () => {
    const html = renderTree({ data: data([wf('w1', 'Brownstone nurtures'), wf('w2', 'Expired hot leads')]) })
    const t = text(html)
    expect(t.indexOf('Groups')).toBeLessThan(t.indexOf('Workflows'))
    expect(t).toMatch(/Workflows\s+Brownstone nurtures\s+Expired hot leads/)
    expect(linkTag(html, '/pipeline?wf=w1')).toContain('data-sidebar-row') // part of the ↑ ↓ walk
    expect(linkTag(html, '/pipeline?wf=w2')).not.toContain('aria-current')
  })

  it('the open workflow is marked', () => {
    const html = renderTree({ data: data([wf('w1', 'Brownstone nurtures'), wf('w2', 'Expired hot leads')]), pathname: '/pipeline', activeWorkflowId: 'w2' })
    expect(linkTag(html, '/pipeline?wf=w2')).toContain('aria-current="page"')
    expect(linkTag(html, '/pipeline?wf=w1')).not.toContain('aria-current')
  })

  it('no workflows yet: a plain hint; nothing while the sidebar loads', () => {
    expect(text(renderTree({ data: data([]) }))).toContain('No workflows yet. Save a view on the Pipeline to keep it here.')
    expect(text(renderTree({ data: null }))).not.toContain('Workflows')
  })

  it('which group or workflow is "open", from the address', () => {
    const at = (path: string) => {
      const u = new URL(path, 'http://x')
      return activeSidebarItems(u.pathname, u.searchParams)
    }
    expect(at('/leads?group=g1')).toEqual({ groupId: 'g1', workflowId: null })
    expect(at('/pipeline?groups=g1')).toEqual({ groupId: 'g1', workflowId: null })
    expect(at('/pipeline?groups=g1&view=table&tier=hot')).toEqual({ groupId: 'g1', workflowId: null })
    expect(at('/pipeline?groups=g1,g2')).toEqual({ groupId: null, workflowId: null })
    expect(at('/pipeline?wf=w1&view=board&groups=g1')).toEqual({ groupId: null, workflowId: 'w1' })
    expect(at('/pipeline')).toEqual({ groupId: null, workflowId: null })
    expect(at('/lists/l1?group=g1')).toEqual({ groupId: null, workflowId: null })
    expect(activeSidebarItems(null, null)).toEqual({ groupId: null, workflowId: null })
  })
})

describe('the board, with group colors', () => {
  const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
  const html = renderToStaticMarkup(
    h(AppRouterContext.Provider, { value: router }, h(TooltipProvider, null, h(ToastProvider, null, h(PipelineView, pageData())))),
  )
  const header = (groupId: string) => new RegExp(`<header[^>]*data-column-header="${groupId}"[^>]*>[\\s\\S]*?</header>`).exec(html)![0]

  it("each column header shows its group's color dot (theme tokens, never raw colors)", () => {
    expect(header('g_hot')).toMatch(/class="[^"]*\bbg-group-red\b/)
    expect(header('g_nurture')).toMatch(/class="[^"]*\bbg-group-green\b/)
    expect(header('g_appt')).toMatch(/class="[^"]*\bbg-group-blue\b/)
  })

  it("a card's groups carry their colors", () => {
    const card = /<article[^>]*data-card="lead_1"[\s\S]*?<\/article>/.exec(html)![0]
    const groups = /data-testid="card-groups"[\s\S]*?<\/div>/.exec(card)![0]
    expect(groups).toMatch(/bg-group-red/)
    expect(groups).toMatch(/bg-group-green/)
  })
})
