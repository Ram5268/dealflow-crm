import { test, expect } from '@playwright/test'

// End-to-end proof that the Basic auth gate is wired into the real middleware,
// not just unit-correct.
//
// SKIPPED BY DEFAULT. The Playwright suite runs against a separately started
// `pnpm boot-standalone` server, so a test cannot set or unset that process's
// env vars — the gate's state is fixed for the whole run. Enabling it would
// also 401 the other 54 specs, which send no credentials.
//
// To run it, start the server WITH the gate on and point this spec at the same
// password, in its own invocation:
//
//   BASIC_AUTH_PASSWORD=testpw npx next dev
//   E2E_BASIC_AUTH_PASSWORD=testpw pnpm test:e2e -- --grep @basic-auth
//
// Use `next dev`, NOT `pnpm boot-standalone`: the boot script polls
// /api/core-data/health with no credentials, so with the gate on it 401s and
// reports BOOT FAILED even though the server came up fine. These four tests
// need no mock-compliance stack, so `next dev` is sufficient.
//
// Everyday runs leave both unset: the gate is disabled and this file skips.
const PASSWORD = process.env.E2E_BASIC_AUTH_PASSWORD
const USER = process.env.E2E_BASIC_AUTH_USER ?? 'ryan'

const PROTECTED_PATH = '/'
// Exempt by design — Twilio cannot send Basic credentials. See
// BASIC_AUTH_EXEMPT_PATHS in src/lib/auth/basicAuth.ts.
const EXEMPT_PATH = '/api/telephony/webhook/status'

test.describe('@basic-auth deploy gate', () => {
  test.skip(
    !PASSWORD,
    'Set E2E_BASIC_AUTH_PASSWORD (and boot the server with the same BASIC_AUTH_PASSWORD) to run.',
  )

  test('401s an unauthenticated request and challenges the browser', async ({
    request,
  }) => {
    const res = await request.get(PROTECTED_PATH)
    expect(res.status()).toBe(401)
    expect(res.headers()['www-authenticate']).toBe('Basic realm="DealFlow CRM"')
  })

  test('401s wrong credentials', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
      httpCredentials: { username: USER, password: `${PASSWORD}-wrong` },
    })
    const res = await ctx.get(PROTECTED_PATH)
    expect(res.status()).toBe(401)
    await ctx.dispose()
  })

  test('serves the app with correct credentials', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
      httpCredentials: { username: USER, password: PASSWORD! },
    })
    const res = await ctx.get(PROTECTED_PATH)
    expect(res.status()).toBe(200)
    await ctx.dispose()
  })

  test('leaves exempt webhook routes reachable without credentials', async ({
    request,
  }) => {
    // The route rejects on its own (403, invalid Twilio signature) rather than
    // 401ing at the gate — which is exactly the point: the middleware let it
    // through and the route's own verifier ran.
    const res = await request.post(EXEMPT_PATH, { form: {} })
    expect(res.status()).not.toBe(401)
  })
})
