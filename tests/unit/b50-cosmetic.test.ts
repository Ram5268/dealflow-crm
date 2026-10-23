import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ToastProvider, TooltipProvider } from '@/components/ui'
import { LeadsView } from '@/app/leads/LeadsView'
import type { AppliedSort, LeadRow } from '@/lib/leads/list'

// Brief 50 PR 14 (open item 6.16), the cosmetic clean-up. Made-up names, ids
// and file names only.

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }
const BY_NAME: AppliedSort = { key: 'displayName', dir: 'asc', fromView: false }

const row = (i: number, source: string | null): LeadRow => ({
  id: `lead_${i}`,
  displayName: `Test Owner ${i}`,
  statusLabel: null,
  priorityScore: null,
  source,
  address: `${100 + i} Example St`,
  contactCount: 1,
  updatedAt: '2026-10-18T12:00:00.000Z',
})

function render(props: Partial<Parameters<typeof LeadsView>[0]>): string {
  return renderToStaticMarkup(
    h(AppRouterContext.Provider, { value: router },
      h(TooltipProvider, null,
        h(ToastProvider, null,
          h(LeadsView, {
            rows: [],
            total: 0,
            page: 1,
            pageSize: 100,
            sort: BY_NAME,
            q: '',
            viewId: '',
            views: [],
            ...props,
          } as Parameters<typeof LeadsView>[0])))),
  )
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const src = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

function filesUnder(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir)).flatMap((name) => {
    const path = `${dir}/${name}`
    return statSync(join(process.cwd(), path)).isDirectory() ? filesUnder(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('leads table: Source reads in words', () => {
  it('an upload shows its Source label, not "import:<id>"; the date and file on hover', () => {
    const html = render({
      rows: [row(1, 'import:imp_test_1'), row(2, 'manual'), row(3, null)],
      total: 3,
      uploads: { imp_test_1: { label: 'Mojo Export', filename: 'test-sellers.csv', createdAt: '2026-10-19T02:30:00.000Z' } },
    } as Partial<Parameters<typeof LeadsView>[0]>)
    const t = text(html)
    expect(t).not.toContain('import:')
    expect(t).not.toContain('imp_test_1')
    expect(t).toContain('Mojo Export')
    expect(html).toContain('title="Mojo Export · uploaded Oct 18, 2026 · test-sellers.csv"')
    expect(t).toContain('Added by hand')
  })
})

describe('stale "ships in M3/M4" tooltips are gone', () => {
  it('no screen mentions a milestone that already shipped', () => {
    const hits = [...filesUnder('src/app'), ...filesUnder('src/components')].filter((f) => /ships? in M\d/i.test(src(f)))
    expect(hits).toEqual([])
  })

  it('the controls stay greyed out, and the real reason stays', () => {
    const view = src('src/app/leads/LeadsView.tsx')
    expect(view).toMatch(/<DropdownItem disabled[\s\S]{0,300}Add to sequence/)
    expect(view).toContain('{sequencesOffReason}')
    const page = src('src/app/leads/[id]/page.tsx')
    expect(page).toMatch(/<Button disabled>\s*<Mail size=\{13\} \/>\s*Email/)
    expect(page).toContain('disabledReason={sequencesOffReason()}')
  })
})

describe('comments say where a rule comes from', () => {
  it('the email switch names Ryan\'s instruction and the engineering precaution, not "Ryan\'s rule"', () => {
    const config = src('src/lib/comms/email/config.ts')
    expect(config).not.toMatch(/Ryan's rule/i)
    expect(config).toContain("Ryan's instruction")
    expect(config).toContain('engineering precaution')
  })

  it('the dialer no longer claims the call stream always reconnects', () => {
    expect(src('src/app/dialer/components/DialerShell.tsx')).not.toMatch(/auto-reconnects/)
  })
})

describe('test phone numbers stay in the fictional 555-0100 to 555-0199 range', () => {
  it('the phone backfill test', () => {
    const body = src('tests/unit/phone-backfill-run.test.ts')
    const lines = [...body.matchAll(/\d{3}[\s.)-]*555[\s.-]?(\d{4})(?!\d)/g)].map((m) => Number(m[1]))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.filter((n) => n < 100 || n > 199)).toEqual([])
  })
})
