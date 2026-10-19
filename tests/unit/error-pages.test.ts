import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement as h, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { EmptyState } from '@/components/ui'
import { ErrorScreen, logPageError } from '@/components/ErrorScreen'
import PageError from '@/app/error'
import GlobalError from '@/app/global-error'
import LeadError from '@/app/leads/[id]/error'
import NotFound from '@/app/not-found'

// Brief 50 PR 2 (open item 6.2, audit M27): when a page breaks, the CRM shows
// a plain-English page with "Try again" and a way back, instead of Next's
// generic error screen. No technical details on screen (engineering
// precaution: an error's message can carry data, and it means nothing to the
// reader); Next's short digest is shown as a reference for the server's logs.
// Made-up text only.

const router: AppRouterInstance = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }

// What a broken read might say. None of it may reach the screen.
const MESSAGE = 'relation "Lead" does not exist (Test Owner 12, 100 Example St)'
const STACK = 'Error: boom\n    at LeadDetailPage (/var/task/.next/server/app/leads/[id]/page.js:1:2345)'

function boom(digest?: string): Error & { digest?: string } {
  const err = new Error(MESSAGE) as Error & { digest?: string }
  err.stack = STACK
  if (digest) err.digest = digest
  return err
}

type BoundaryProps = { error: Error & { digest?: string }; reset: () => void; unstable_retry?: () => void }
type Boundary = (p: BoundaryProps) => ReactNode

function html(node: ReactNode): string {
  return renderToStaticMarkup(h(AppRouterContext.Provider, { value: router }, node))
}

const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const textOf = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')

/** The text inside an element tree (strings and numbers only). */
function textIn(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textIn).join('')
  if (isValidElement(node)) return textIn((node.props as { children?: ReactNode }).children)
  return ''
}

// Expanded while walking: the screen itself and the design system's EmptyState
// (both plain functions), so the walk reaches the real buttons and links.
const EXPAND = new Set<unknown>([ErrorScreen, EmptyState])

/** Every element in the tree a boundary returns, with its props. */
function elementsOf(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((n) => elementsOf(n, out))
  } else if (isValidElement(node)) {
    out.push(node)
    if (EXPAND.has(node.type)) {
      // What it draws (which already holds the elements passed in its props).
      elementsOf((node.type as (p: unknown) => ReactNode)(node.props), out)
    } else {
      for (const v of Object.values(node.props as Record<string, unknown>)) {
        if (Array.isArray(v) || isValidElement(v)) elementsOf(v as ReactNode, out)
      }
    }
  }
  return out
}

/**
 * Draw a boundary inside a real React render (so its hooks run as they do in
 * Next), keep the tree it returns, and press its "Try again" button.
 */
function pressTryAgain(Page: Boundary, props: BoundaryProps): void {
  let tree: ReactNode = null
  function Probe() {
    tree = Page(props)
    return null
  }
  html(h(Probe))
  const buttons = elementsOf(tree).filter(
    (el) => typeof (el.props as { onClick?: unknown }).onClick === 'function' && textIn(el).trim() === 'Try again',
  )
  expect(buttons, 'exactly one "Try again" button').toHaveLength(1)
  ;(buttons[0].props as { onClick: (e?: unknown) => void }).onClick({ type: 'click' })
}

/** The opening tag of the link whose text is `label`. */
function linkTag(markup: string, label: string): string {
  const m = new RegExp(`<a([^>]*)>(?:(?!</a>)[\\s\\S])*${label}(?:(?!</a>)[\\s\\S])*</a>`).exec(markup)
  expect(m, `a link "${label}" is rendered`).not.toBeNull()
  return m![1]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the page error screen (src/app/error.tsx)', () => {
  const draw = (digest?: string) => html(h(PageError, { error: boom(digest), reset: () => {}, unstable_retry: () => {} }))

  it('says what happened in plain English, with "Try again" and a way back to Leads', () => {
    const markup = draw('2481937465')
    const text = textOf(markup)
    expect(text).toContain('Something went wrong on this page')
    expect(markup).toMatch(/<button[^>]*>\s*Try again\s*<\/button>/)
    expect(linkTag(markup, 'Go to Leads')).toMatch(/href="\/leads"/)
    expect(markup).toContain('role="alert"')
  })

  it("shows Next's short digest as a reference, and nothing technical", () => {
    const markup = draw('2481937465')
    expect(textOf(markup)).toContain('Reference: 2481937465')
    expect(decode(markup)).not.toContain(MESSAGE)
    expect(decode(markup)).not.toContain('does not exist')
    expect(decode(markup)).not.toContain('page.js')
    expect(decode(markup)).not.toContain('Test Owner 12')
  })

  it('with no digest (an error in the browser), no reference line', () => {
    expect(textOf(draw())).not.toContain('Reference')
  })

  it('draws inside the app shell: no second <main>, no <html>', () => {
    const markup = draw('1')
    expect(markup).not.toContain('<main')
    expect(markup).not.toContain('<html')
  })

  it('"Try again" re-reads the page from the server (unstable_retry) when Next offers it', () => {
    const reset = vi.fn()
    const retry = vi.fn()
    pressTryAgain(PageError, { error: boom('1'), reset, unstable_retry: retry })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith()
    expect(reset).not.toHaveBeenCalled()
  })

  it('"Try again" falls back to reset when that is all Next passes', () => {
    const reset = vi.fn()
    pressTryAgain(PageError, { error: boom('1'), reset })
    expect(reset).toHaveBeenCalledTimes(1)
    expect(reset).toHaveBeenCalledWith()
  })
})

describe('the whole-app error screen (src/app/global-error.tsx)', () => {
  const draw = (digest?: string) => html(h(GlobalError, { error: boom(digest), reset: () => {}, unstable_retry: () => {} }))

  it('brings its own <html> and <body>, with the theme painted before first paint', () => {
    const markup = draw('77')
    expect(markup).toMatch(/<html[^>]*lang="en"/)
    expect(markup).toContain('<body')
    expect(markup).toContain('</body></html>')
    // The same head script the root layout uses (light/dark from the stored choice).
    expect(markup).toContain('dealflow-theme')
    expect(markup).toContain('data-theme')
    expect(markup).toMatch(/<title>[^<]*DealFlow CRM<\/title>/)
  })

  it('says what happened in plain English, with "Try again" and a full reload of Focus', () => {
    const markup = draw('77')
    const text = textOf(markup)
    expect(text).toContain('Something went wrong on this page')
    expect(markup).toMatch(/<button[^>]*>\s*Try again\s*<\/button>/)
    // A plain link (a full page load), so a broken app frame starts over cleanly.
    const tag = linkTag(markup, 'Go to Focus')
    expect(tag).toMatch(/href="\/"/)
    expect(text).toContain('Reference: 77')
  })

  it('shows nothing technical', () => {
    const markup = decode(draw('77'))
    expect(markup).not.toContain(MESSAGE)
    expect(markup).not.toContain('page.js')
  })

  it('"Try again" retries (unstable_retry), or falls back to reset', () => {
    const reset = vi.fn()
    const retry = vi.fn()
    pressTryAgain(GlobalError, { error: boom('1'), reset, unstable_retry: retry })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()

    const resetOnly = vi.fn()
    pressTryAgain(GlobalError, { error: boom('1'), reset: resetOnly })
    expect(resetOnly).toHaveBeenCalledTimes(1)
  })
})

describe("the lead page's own error screen (src/app/leads/[id]/error.tsx)", () => {
  it('names the lead page, offers "Try again" and "Back to Leads"', () => {
    const markup = html(h(LeadError, { error: boom('5'), reset: () => {}, unstable_retry: () => {} }))
    const text = textOf(markup)
    expect(text).toContain("This lead couldn't load")
    expect(markup).toMatch(/<button[^>]*>\s*Try again\s*<\/button>/)
    expect(linkTag(markup, 'Back to Leads')).toMatch(/href="\/leads"/)
    expect(text).toContain('Reference: 5')
    expect(decode(markup)).not.toContain(MESSAGE)
  })

  it('"Try again" retries', () => {
    const retry = vi.fn()
    pressTryAgain(LeadError, { error: boom(), reset: vi.fn(), unstable_retry: retry })
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('the page-not-found screen (src/app/not-found.tsx)', () => {
  it('says so in plain English, with a way back to Leads', () => {
    const markup = html(h(NotFound))
    expect(textOf(markup)).toContain("We couldn't find that page")
    expect(linkTag(markup, 'Go to Leads')).toMatch(/href="\/leads"/)
  })
})

describe('logPageError (the browser-console line the error screens write)', () => {
  it("logs where it happened and the digest, so it matches the server's log line", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = boom('2481937465')
    logPageError('page', err)
    expect(spy).toHaveBeenCalledTimes(1)
    const [first, second, third] = spy.mock.calls[0]
    expect(first).toContain('page')
    expect(second).toContain('2481937465')
    expect(third).toBe(err)
  })

  it('logs without a digest too', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => logPageError('lead page', boom())).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
