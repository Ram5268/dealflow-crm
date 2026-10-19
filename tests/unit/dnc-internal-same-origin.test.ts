import { describe, it, expect } from 'vitest'
import { POST } from '@/app/api/compliance/dnc/internal/route'

// Brief 50 (PR 16), engineering precaution (Brief 47's report, "found but not
// fixed"): POST /api/compliance/dnc/internal answers only the CRM's own pages.
// A page on another site could otherwise make Ryan's logged-in browser (the
// browser re-sends the saved password by itself) add an opt-out. Worst case
// an extra opt-out; the route never removes one.
//
// No database here: every request carries a body that isn't JSON, so a request
// the check lets through stops at the route's own 400 ("invalid_json") before
// any database call, and a refused one is a 403 with its body never read.
// The database-backed half (the row is written or not) is
// tests/integration-local/dnc-internal-same-origin.test.ts.

const URL_ = 'http://localhost/api/compliance/dnc/internal'

function send(headers: Record<string, string>) {
  const request = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...headers },
    body: 'not json',
  })
  return { request, response: POST(request) }
}

async function expectRefused(headers: Record<string, string>) {
  const { request, response } = send(headers)
  const res = await response
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'cross_site_request' })
  // Refused before the body is read: nothing can be written.
  expect(request.bodyUsed).toBe(false)
}

async function expectLetThrough(headers: Record<string, string>) {
  const { request, response } = send(headers)
  const res = await response
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'invalid_json' })
  expect(request.bodyUsed).toBe(true)
}

describe('dnc/internal: cross-site browser requests are refused (403)', () => {
  it.each([
    ['another site (modern browser)', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ['another subdomain of the same site', { 'sec-fetch-site': 'same-site', origin: 'https://other.localhost' }],
    ['"cross-site" even when the Origin looks like ours', { 'sec-fetch-site': 'cross-site', origin: 'http://localhost' }],
    ['a request the browser marks "none" (not from a page)', { 'sec-fetch-site': 'none' }],
    ['an empty Sec-Fetch-Site', { 'sec-fetch-site': '' }],
    ['another site (older browser: Origin only)', { origin: 'https://evil.example' }],
    ['a sandboxed frame or data: page (Origin "null")', { origin: 'null' }],
    ['the same host on another port', { origin: 'http://localhost:4000' }],
    ['an Origin that is not a URL', { origin: 'not a url' }],
  ])('%s', async (_label, headers) => {
    await expectRefused(headers)
  })
})

describe("dnc/internal: the CRM's own pages and non-browser clients get through", () => {
  it.each([
    ["the Settings form (the browser says same-origin)", { 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }],
    ['same-origin with no Origin header', { 'sec-fetch-site': 'same-origin' }],
    // The browser's own verdict wins: it can't be set by a page, and it keeps
    // the form working if a proxy ever rewrites the Host the route sees.
    ['same-origin per the browser, behind a proxy that rewrote the host', { 'sec-fetch-site': 'same-origin', origin: 'https://crm.example.test' }],
    ['an older browser: Origin matches the address', { origin: 'http://localhost' }],
    ['an older browser: Origin matches the Host header', { origin: 'https://crm.example.test', host: 'crm.example.test' }],
    ['an older browser: Origin matches X-Forwarded-Host', { origin: 'https://crm.example.test', 'x-forwarded-host': 'crm.example.test' }],
    // Browsers send Origin on every cross-site POST, so a request with neither
    // header isn't another site riding on Ryan's saved login: it's a script
    // that had to send the password itself (the middleware's gate runs first).
    ['a script with no Origin and no Sec-Fetch-Site', {}],
  ])('%s', async (_label, headers) => {
    await expectLetThrough(headers)
  })
})
