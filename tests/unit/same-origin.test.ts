import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import { BASIC_AUTH_EXEMPT_PATHS } from '@/lib/auth/basicAuth'

// Brief 50 (PR 18), engineering precaution (the planner's review, Brief 50
// Revision 2, 2026-10-23): every save in the CRM answers only the CRM's own
// pages. The browser re-sends the CRM's saved Basic-auth password by itself,
// even on a request another website's page starts, and most routes read JSON
// whatever the Content-Type, so without this a cross-site `text/plain` form
// could save things (e.g. confirm a calling-hours policy, one of the calling
// gates). The check lives in the middleware, after the password wall; the
// machine routes the wall already exempts (Twilio, crons, Gmail push) are
// exempt here too. GET/HEAD/OPTIONS never change anything and always pass.
//
// No database: this drives the real middleware. A request it lets through
// comes back as Next's "continue" answer (x-middleware-next: 1); a refused one
// is a 403 the route never sees. The database-backed half (nothing is written)
// is tests/integration-local/same-origin-saves.test.ts.

const CRM = 'http://localhost:3518'
const SAVE = '/api/compliance/policy/confirm'
const OURS = CRM
const EVIL = 'https://evil.example'

const BASIC_PASSWORD = 'made-up-pw' // a made-up test value, not a real password

function request(method: string, pathname: string, headers: Record<string, string> = {}): NextRequest {
  const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase())
  return new NextRequest(new URL(pathname, CRM), {
    method,
    headers: { 'content-type': 'text/plain', ...headers },
    ...(hasBody ? { body: '{"made":"up"}' } : {}),
  })
}

const run = (method: string, pathname: string, headers: Record<string, string> = {}) =>
  middleware(request(method, pathname, headers))

const wentThrough = (res: Response) => res.headers.get('x-middleware-next') === '1'

async function expectRefused(res: Response) {
  expect(res.status).toBe(403)
  expect(wentThrough(res)).toBe(false)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(res.headers.get('cache-control')).toBe('no-store')
  const body = await res.json()
  expect(body).toEqual({
    error: "Refused: this change didn't come from the CRM's own pages. Open the CRM and try again.",
    code: 'cross_site_request',
  })
}

function expectThrough(res: Response) {
  expect(res.status).toBe(200)
  expect(wentThrough(res)).toBe(true)
}

beforeEach(() => {
  // Off Vercel with no password: the wall is open (local dev / E2E), so these
  // tests see the same-origin check alone unless they turn the wall on.
  vi.stubEnv('BASIC_AUTH_PASSWORD', undefined)
  vi.stubEnv('BASIC_AUTH_USER', undefined)
  vi.stubEnv('VERCEL_ENV', undefined)
  vi.stubEnv('NODE_ENV', 'test')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('a save from another website is refused (403) before any route runs', () => {
  it.each<[string, Record<string, string>]>([
    ['another website (current browser)', { origin: EVIL, 'sec-fetch-site': 'cross-site' }],
    ['another website (older browser: Origin only)', { origin: EVIL }],
    ['another site on the same machine (another port)', { origin: 'http://localhost:4000', 'sec-fetch-site': 'same-site' }],
    ['another port, Origin only', { origin: 'http://localhost:4000' }],
    ['Origin "null" (a sandboxed frame, a data: page, a no-referrer form)', { origin: 'null' }],
    ['an Origin that is not an address', { origin: 'not a url' }],
    ['an empty Origin', { origin: '' }],
    ['a browser extension', { origin: 'chrome-extension://abcdefghijklmnop', 'sec-fetch-site': 'none' }],
    ['the browser says cross-site although the Origin looks like ours', { origin: OURS, 'sec-fetch-site': 'cross-site' }],
    ['the browser says same-site (a sibling site) although the Origin looks like ours', { origin: OURS, 'sec-fetch-site': 'same-site' }],
    ['no Origin, the browser says cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['no Origin, an empty Sec-Fetch-Site', { 'sec-fetch-site': '' }],
    ['no Origin, an unknown Sec-Fetch-Site', { 'sec-fetch-site': 'sideways' }],
    ['another website in the Referer only', { referer: `${EVIL}/page` }],
    ['an unreadable Referer only', { referer: 'garbage' }],
    ["another website's Origin, even with our Referer", { origin: EVIL, referer: `${OURS}/leads` }],
    ["a forged Host can't help another website's Origin", { origin: EVIL, 'x-forwarded-host': 'crm.example.test' }],
    // Deliberate (this PR): a request with none of the three headers isn't
    // from a current browser (they all send Origin on every POST), and an old
    // browser that sends none of them could be another site's form. Scripts
    // send a matching Origin (see the PR text).
    ['no Origin, no Sec-Fetch-Site, no Referer', {}],
  ])('%s', async (_label, headers) => {
    await expectRefused(await run('POST', SAVE, headers))
  })

  it.each(['PUT', 'PATCH', 'DELETE', 'PROPFIND'])('%s from another website is refused too', async (method) => {
    await expectRefused(await run(method, '/api/leads/lead_made_up', { origin: EVIL, 'sec-fetch-site': 'cross-site' }))
    await expectRefused(await run(method, '/api/leads/lead_made_up', {}))
  })

  it.each([
    '/api/leads',
    '/api/leads/lead_made_up',
    '/api/contacts/contact_made_up',
    '/api/imports',
    '/api/imports/imp_made_up/commit',
    '/api/core-data/lists/list_made_up/members',
    '/api/core-data/groups',
    '/api/compliance/dnc/internal',
    '/api/compliance/policy/confirm',
    '/api/telephony/dial-sessions',
    '/api/comms/messages',
    '/leads',
    // Siblings of exempt routes don't inherit the exemption.
    '/api/cron',
    '/api/cron/not-a-real-job',
    '/api/telephony/webhook',
    '/api/comms/webhook/other',
  ])('applies to every save route: %s', async (pathname) => {
    await expectRefused(await run('POST', pathname, { origin: EVIL, 'sec-fetch-site': 'cross-site' }))
  })

  it('logs one line with the method, path and why (no body, no credentials)', async () => {
    const warn = vi.mocked(console.warn)
    await run('POST', SAVE, { origin: EVIL, 'sec-fetch-site': 'cross-site', authorization: 'Basic bWFkZTp1cA==' })
    // (The open wall may also warn once per process that it is off.)
    const mine = warn.mock.calls.filter((call) => String(call[0]).startsWith('Refused a save'))
    expect(mine).toHaveLength(1)
    const line = JSON.stringify(mine[0])
    expect(line).toContain('POST')
    expect(line).toContain(SAVE)
    expect(line).toContain('cross-site')
    expect(line).not.toContain('bWFkZTp1cA')
    expect(line).not.toContain('made')
  })
})

describe("the CRM's own pages still save", () => {
  it.each<[string, Record<string, string>]>([
    ['a CRM page in a current browser', { origin: OURS, 'sec-fetch-site': 'same-origin' }],
    ['a CRM page in an older browser (Origin only)', { origin: OURS }],
    ['an Origin in capitals (addresses ignore case)', { origin: 'HTTP://LOCALHOST:3518' }],
    ['Origin matches the Host header (behind a proxy)', { origin: 'https://crm.example.test', host: 'crm.example.test' }],
    ["Origin matches X-Forwarded-Host (Vercel's proxy)", { origin: 'https://crm.example.test', 'x-forwarded-host': 'crm.example.test' }],
    ['Origin matches the first of several X-Forwarded-Host values', { origin: 'https://crm.example.test', 'x-forwarded-host': 'crm.example.test, inner.example.test' }],
    ['no Origin, the browser says same-origin', { 'sec-fetch-site': 'same-origin' }],
    // The browser's own verdict wins (Brief 50 PR 16's reviewed behaviour): a
    // page can't set it, and it keeps saves working if a proxy ever changed
    // the host the server sees.
    ['the browser says same-origin, behind a proxy that changed the host', { 'sec-fetch-site': 'same-origin', origin: 'https://crm.example.test' }],
    ['the browser says same-origin, Origin "null" (a CRM page with a no-referrer policy)', { 'sec-fetch-site': 'same-origin', origin: 'null' }],
    ['no Origin, the browser says the person started it (none)', { 'sec-fetch-site': 'none' }],
    ['no Origin and no Sec-Fetch-Site, our Referer', { referer: `${OURS}/leads/lead_made_up` }],
  ])('%s', (_label, headers) => {
    expectThrough(run('POST', SAVE, headers))
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('%s from a CRM page goes through', (method) => {
    expectThrough(run(method, '/api/leads/lead_made_up', { origin: OURS, 'sec-fetch-site': 'same-origin' }))
  })

  it('keeps setting the correlation id on what it lets through', () => {
    const res = run('POST', SAVE, { origin: OURS, 'x-correlation-id': 'corr-made-up' })
    expectThrough(res)
    expect(res.headers.get('x-correlation-id')).toBe('corr-made-up')
  })
})

describe('reading never changes anything: GET, HEAD and OPTIONS always pass', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('%s from another website (or with no headers) passes', (method) => {
    expectThrough(run(method, '/api/leads', { origin: EVIL, 'sec-fetch-site': 'cross-site' }))
    expectThrough(run(method, '/leads', {}))
  })
})

describe('the machine routes the password wall exempts are exempt here too', () => {
  it('is exactly the password wall’s 14 routes', () => {
    expect(BASIC_AUTH_EXEMPT_PATHS).toHaveLength(14)
  })

  it.each([...BASIC_AUTH_EXEMPT_PATHS])('%s (no browser headers, or a foreign Origin) passes', (pathname) => {
    expectThrough(run('POST', pathname, {}))
    expectThrough(run('POST', pathname, { origin: EVIL, 'sec-fetch-site': 'cross-site' }))
    expectThrough(run('POST', `${pathname}/`, {}))
  })
})

describe('with the password wall on (as in production)', () => {
  const login = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`

  beforeEach(() => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_USER', 'ryan')
    vi.stubEnv('BASIC_AUTH_PASSWORD', BASIC_PASSWORD)
  })

  it('the wall answers first: no login means 401, whatever the Origin', () => {
    const res = run('POST', SAVE, { origin: EVIL, 'sec-fetch-site': 'cross-site' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="DealFlow CRM"')
  })

  it("another website riding the browser's saved login gets 403", async () => {
    await expectRefused(
      await run('POST', SAVE, { origin: EVIL, 'sec-fetch-site': 'cross-site', authorization: login('ryan', BASIC_PASSWORD) }),
    )
  })

  it('a script that sends the password but no Origin gets 403; with a matching Origin it goes through', async () => {
    await expectRefused(await run('POST', SAVE, { authorization: login('ryan', BASIC_PASSWORD) }))
    expectThrough(run('POST', SAVE, { origin: OURS, authorization: login('ryan', BASIC_PASSWORD) }))
  })

  it("a CRM page with the saved login goes through", () => {
    expectThrough(run('POST', SAVE, { origin: OURS, 'sec-fetch-site': 'same-origin', authorization: login('ryan', BASIC_PASSWORD) }))
  })

  it('the exempt machine routes still pass with no login and no Origin', () => {
    for (const pathname of BASIC_AUTH_EXEMPT_PATHS) expectThrough(run('POST', pathname, {}))
  })

  it('a deployment with no password stays locked (503) before the check', () => {
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(run('POST', SAVE, { origin: OURS }).status).toBe(503)
  })
})
