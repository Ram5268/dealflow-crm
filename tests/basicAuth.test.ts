import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  basicAuth,
  isExemptPath,
  BASIC_AUTH_EXEMPT_PATHS,
} from '@/lib/auth/basicAuth'

// Unit coverage for the Vercel access gate. No DB, no network — basicAuth is a
// pure function over (env, request).

const USER = 'ryan'
const PASSWORD = 's3cret-pw'

function req(pathname: string, authorization?: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://localhost:3000'), {
    headers: authorization ? { authorization } : {},
  })
}

function basicHeader(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`
}

const ORIGINAL_USER = process.env.BASIC_AUTH_USER
const ORIGINAL_PASSWORD = process.env.BASIC_AUTH_PASSWORD

beforeEach(() => {
  delete process.env.BASIC_AUTH_USER
  delete process.env.BASIC_AUTH_PASSWORD
  // Brief 47 (PR 3): every test starts off Vercel (local dev / E2E / CI) unless
  // it says otherwise, so a VERCEL_ENV in the shell can't change the results.
  vi.stubEnv('VERCEL_ENV', undefined)
  // Brief 50 (PR 16): with no VERCEL_ENV, a production build counts as
  // deployed, so pin vitest's own NODE_ENV for the same reason.
  vi.stubEnv('NODE_ENV', 'test')
})

afterEach(() => {
  // Undo every vi.stubEnv first (VERCEL_ENV and any per-test stubs), then
  // restore the two hand-managed variables below.
  vi.unstubAllEnvs()
  // Restore rather than delete: the gate is env-driven and this suite shares a
  // process with every other file (vitest.config sets isolate: false).
  if (ORIGINAL_USER === undefined) delete process.env.BASIC_AUTH_USER
  else process.env.BASIC_AUTH_USER = ORIGINAL_USER
  if (ORIGINAL_PASSWORD === undefined) delete process.env.BASIC_AUTH_PASSWORD
  else process.env.BASIC_AUTH_PASSWORD = ORIGINAL_PASSWORD
})

describe('basicAuth — disabled when no password is configured (local dev and E2E: no VERCEL_ENV)', () => {
  it('passes through when BASIC_AUTH_PASSWORD is unset', () => {
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('passes through when BASIC_AUTH_PASSWORD is empty', () => {
    process.env.BASIC_AUTH_PASSWORD = ''
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('does not prompt even when a bogus Authorization header is present', () => {
    expect(basicAuth(req('/leads', 'Basic bogus')).ok).toBe(true)
  })
})

describe('basicAuth — enabled', () => {
  beforeEach(() => {
    process.env.BASIC_AUTH_PASSWORD = PASSWORD
  })

  it('401s with no Authorization header', () => {
    const result = basicAuth(req('/leads'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected rejection')
    expect(result.response.status).toBe(401)
  })

  it('sends the WWW-Authenticate challenge and a plain-text body', async () => {
    const result = basicAuth(req('/leads'))
    if (result.ok) throw new Error('expected rejection')
    expect(result.response.headers.get('www-authenticate')).toBe(
      'Basic realm="DealFlow CRM"',
    )
    expect(result.response.headers.get('content-type')).toContain('text/plain')
    expect(await result.response.text()).toBe('Authentication required.')
  })

  it('401s on the wrong password', () => {
    expect(basicAuth(req('/leads', basicHeader(USER, 'wrong'))).ok).toBe(false)
  })

  it('401s on the wrong username', () => {
    expect(basicAuth(req('/leads', basicHeader('mallory', PASSWORD))).ok).toBe(
      false,
    )
  })

  it('passes through on correct credentials', () => {
    expect(basicAuth(req('/leads', basicHeader(USER, PASSWORD))).ok).toBe(true)
  })

  it('defaults the username to "ryan" when BASIC_AUTH_USER is unset', () => {
    expect(basicAuth(req('/leads', basicHeader('ryan', PASSWORD))).ok).toBe(true)
  })

  it('honors a custom BASIC_AUTH_USER', () => {
    process.env.BASIC_AUTH_USER = 'broker'
    expect(basicAuth(req('/leads', basicHeader('broker', PASSWORD))).ok).toBe(
      true,
    )
    expect(basicAuth(req('/leads', basicHeader('ryan', PASSWORD))).ok).toBe(
      false,
    )
  })

  it('accepts a password containing a colon', () => {
    process.env.BASIC_AUTH_PASSWORD = 'pa:ss:word'
    expect(basicAuth(req('/leads', basicHeader(USER, 'pa:ss:word'))).ok).toBe(
      true,
    )
  })

  it('gates API routes that are not exempt', () => {
    expect(basicAuth(req('/api/leads')).ok).toBe(false)
    expect(basicAuth(req('/api/telephony/stream')).ok).toBe(false)
    expect(basicAuth(req('/api/comms/oauth/gmail/callback')).ok).toBe(false)
  })
})

describe('basicAuth — malformed Authorization headers are rejected', () => {
  beforeEach(() => {
    process.env.BASIC_AUTH_PASSWORD = PASSWORD
  })

  it.each([
    ['empty header', ''],
    ['wrong scheme', `Bearer ${btoa(`${USER}:${PASSWORD}`)}`],
    ['scheme with no credentials', 'Basic'],
    ['undecodable base64', 'Basic !!!not-base64!!!'],
    ['credentials with no scheme', btoa(`${USER}:${PASSWORD}`)],
    ['no colon separator', `Basic ${btoa(`${USER}${PASSWORD}`)}`],
  ])('401s on %s', (_label, header) => {
    expect(basicAuth(req('/leads', header)).ok).toBe(false)
  })

  it('accepts a lowercase scheme token (RFC 7235 is case-insensitive)', () => {
    const encoded = btoa(`${USER}:${PASSWORD}`)
    expect(basicAuth(req('/leads', `basic ${encoded}`)).ok).toBe(true)
  })
})

describe('basicAuth — constant-time comparison', () => {
  beforeEach(() => {
    process.env.BASIC_AUTH_PASSWORD = PASSWORD
  })

  // The comparison folds length into the difference accumulator instead of
  // returning early on a mismatch, so wrong-length passwords must be rejected
  // by the same path as wrong-content ones — including the degenerate cases
  // where the supplied value is a strict prefix or extension of the real one.
  it.each([
    ['empty password', ''],
    ['one character short', PASSWORD.slice(0, -1)],
    ['strict prefix', PASSWORD.slice(0, 3)],
    ['correct password plus a suffix', `${PASSWORD}x`],
    ['much longer than the real password', 'x'.repeat(4096)],
  ])('401s on a %s', (_label, password) => {
    expect(basicAuth(req('/leads', basicHeader(USER, password))).ok).toBe(false)
  })

  it('rejects a username that is a strict prefix of the real one', () => {
    expect(basicAuth(req('/leads', basicHeader('rya', PASSWORD))).ok).toBe(false)
  })
})

describe('basicAuth — exempt paths', () => {
  beforeEach(() => {
    process.env.BASIC_AUTH_PASSWORD = PASSWORD
  })

  it('covers the 14 reviewed webhook/cron routes', () => {
    expect(BASIC_AUTH_EXEMPT_PATHS).toHaveLength(14)
  })

  it.each([...BASIC_AUTH_EXEMPT_PATHS])(
    'never challenges %s',
    (pathname) => {
      expect(basicAuth(req(pathname)).ok).toBe(true)
    },
  )

  it.each([...BASIC_AUTH_EXEMPT_PATHS])(
    'normalizes the trailing slash on %s',
    (pathname) => {
      expect(basicAuth(req(`${pathname}/`)).ok).toBe(true)
    },
  )

  it('matches exactly, not by prefix', () => {
    // A sibling route under an exempt directory must NOT inherit the exemption.
    expect(isExemptPath('/api/cron')).toBe(false)
    expect(isExemptPath('/api/cron/not-a-real-job')).toBe(false)
    expect(isExemptPath('/api/cron/gmail-sync/extra')).toBe(false)
    expect(isExemptPath('/api/telephony/webhook')).toBe(false)
    expect(isExemptPath('/api/comms/webhook/other')).toBe(false)
  })

  it('does not treat a query string as part of the path', () => {
    const request = new NextRequest(
      new URL('/api/comms/webhook/gmail-push?token=abc', 'http://localhost:3000'),
    )
    expect(basicAuth(request).ok).toBe(true)
  })
})

// Brief 47 (PR 3): engineering precaution (Brief 40 audit M5). On a Vercel
// deployment (VERCEL_ENV is 'production' or 'preview') a missing password locks
// the app with a 503 "not configured" instead of opening it: one deleted or
// mistyped Vercel setting must not open every homeowner's name and number to
// anyone. The exempt webhook and cron routes still pass (they check their own
// secrets). Local dev and E2E (no VERCEL_ENV, or 'development') keep the
// no-prompt path above.
const VERCEL_DEPLOYMENTS = ['production', 'preview'] as const

function expectNotConfigured(result: ReturnType<typeof basicAuth>): Response {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected the not-configured response')
  expect(result.response.status).toBe(503)
  return result.response
}

describe('basicAuth — on Vercel with no password: locked (503), not open', () => {
  it.each(VERCEL_DEPLOYMENTS)(
    '503s /leads on %s when BASIC_AUTH_PASSWORD is empty',
    (vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv)
      vi.stubEnv('BASIC_AUTH_PASSWORD', '')
      expectNotConfigured(basicAuth(req('/leads')))
    },
  )

  it.each(VERCEL_DEPLOYMENTS)(
    '503s /leads on %s when BASIC_AUTH_PASSWORD is unset',
    (vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv)
      vi.stubEnv('BASIC_AUTH_PASSWORD', undefined)
      expectNotConfigured(basicAuth(req('/leads')))
    },
  )

  it('answers in plain text with no Basic prompt (there is no password to ask for)', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    const response = expectNotConfigured(basicAuth(req('/leads')))
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(
      "This app isn't configured: its password setting is missing.",
    )
  })

  it.each([
    '/',
    '/leads/123',
    '/settings',
    '/api/leads',
    '/api/core-data/health',
    '/api/comms/oauth/gmail/callback',
    // Not exempt: siblings of exempt routes don't inherit the exemption.
    '/api/cron',
    '/api/cron/not-a-real-job',
  ])('503s the non-exempt route %s on production', (pathname) => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expectNotConfigured(basicAuth(req(pathname)))
  })

  it('cannot be opened with any credentials, including an empty password', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expectNotConfigured(basicAuth(req('/leads', basicHeader(USER, ''))))
    expectNotConfigured(basicAuth(req('/leads', basicHeader(USER, 'anything'))))
    expectNotConfigured(basicAuth(req('/leads', 'Basic bogus')))
  })

  it.each([...BASIC_AUTH_EXEMPT_PATHS])(
    'lets the exempt route %s through on production (it checks its own secret)',
    (pathname) => {
      vi.stubEnv('VERCEL_ENV', 'production')
      vi.stubEnv('BASIC_AUTH_PASSWORD', '')
      expect(basicAuth(req(pathname)).ok).toBe(true)
      expect(basicAuth(req(`${pathname}/`)).ok).toBe(true)
    },
  )

  it.each([...BASIC_AUTH_EXEMPT_PATHS])(
    'lets the exempt route %s through on preview with the password unset',
    (pathname) => {
      vi.stubEnv('VERCEL_ENV', 'preview')
      vi.stubEnv('BASIC_AUTH_PASSWORD', undefined)
      expect(basicAuth(req(pathname)).ok).toBe(true)
    },
  )
})

describe('basicAuth — off Vercel with no password: no prompt (local dev and E2E)', () => {
  it('passes /leads with no VERCEL_ENV and an empty password', () => {
    vi.stubEnv('VERCEL_ENV', undefined)
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('passes /leads with VERCEL_ENV=development and an empty password', () => {
    vi.stubEnv('VERCEL_ENV', 'development')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('passes /leads with VERCEL_ENV=development and the password unset', () => {
    vi.stubEnv('VERCEL_ENV', 'development')
    vi.stubEnv('BASIC_AUTH_PASSWORD', undefined)
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })
})

describe('basicAuth — on Vercel with a password: unchanged', () => {
  it.each(VERCEL_DEPLOYMENTS)(
    '401s with the Basic prompt on %s when no credentials are sent',
    (vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv)
      vi.stubEnv('BASIC_AUTH_PASSWORD', PASSWORD)
      const result = basicAuth(req('/leads'))
      if (result.ok) throw new Error('expected rejection')
      expect(result.response.status).toBe(401)
      expect(result.response.headers.get('www-authenticate')).toBe(
        'Basic realm="DealFlow CRM"',
      )
    },
  )

  it.each(VERCEL_DEPLOYMENTS)(
    '401s wrong credentials on %s',
    (vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv)
      vi.stubEnv('BASIC_AUTH_PASSWORD', PASSWORD)
      const result = basicAuth(req('/leads', basicHeader(USER, 'wrong')))
      if (result.ok) throw new Error('expected rejection')
      expect(result.response.status).toBe(401)
    },
  )

  it.each(VERCEL_DEPLOYMENTS)(
    'passes the right credentials on %s',
    (vercelEnv) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv)
      vi.stubEnv('BASIC_AUTH_PASSWORD', PASSWORD)
      expect(basicAuth(req('/leads', basicHeader(USER, PASSWORD))).ok).toBe(true)
    },
  )

  it('still lets the exempt routes through on production', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', PASSWORD)
    for (const pathname of BASIC_AUTH_EXEMPT_PATHS) {
      expect(basicAuth(req(pathname)).ok).toBe(true)
    }
  })
})

// Brief 50 (PR 16), engineering precaution (Brief 40 audit M5; Brief 47's
// report, "found but not fixed"; Brief 47's tested hardening patch). Two gaps
// in the lock above:
//   1. A password of only spaces (a mistyped setting) counted as set: the app
//      asked for it, and "ryan" plus those spaces opened it. It now counts as
//      missing: locked (503) on a deployment, the no-prompt path in `next dev`.
//   2. With no VERCEL_ENV at all (Vercel's system variables not exposed to the
//      project), a missing password opened the app. A production build
//      (`next build` inlines NODE_ENV=production) now counts as deployed.
//      `next dev` (local dev, E2E, boot-standalone) keeps the no-prompt path.
const BLANK_PASSWORDS = [' ', '   ', '\n', '\t ', ' \r\n '] as const

describe('basicAuth — a password of only spaces counts as missing', () => {
  it.each(
    VERCEL_DEPLOYMENTS.flatMap((vercelEnv) =>
      BLANK_PASSWORDS.map((blank) => [vercelEnv, blank] as const),
    ),
  )('503s on %s with the password %j, even with matching credentials', (vercelEnv, blank) => {
    vi.stubEnv('VERCEL_ENV', vercelEnv)
    vi.stubEnv('BASIC_AUTH_PASSWORD', blank)
    expectNotConfigured(basicAuth(req('/leads')))
    expectNotConfigured(basicAuth(req('/leads', basicHeader(USER, blank))))
    expectNotConfigured(basicAuth(req('/api/leads', basicHeader(USER, ''))))
  })

  it('still lets the exempt routes through on production (they check their own secret)', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '   ')
    for (const pathname of BASIC_AUTH_EXEMPT_PATHS) {
      expect(basicAuth(req(pathname)).ok).toBe(true)
    }
  })

  it('in next dev (no VERCEL_ENV) it is the no-prompt path, like a missing password', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '   ')
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('a real password with spaces around it is still compared exactly as set', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', ' pw-fake ')
    const prompt = basicAuth(req('/leads'))
    if (prompt.ok) throw new Error('expected the Basic prompt')
    expect(prompt.response.status).toBe(401)
    expect(basicAuth(req('/leads', basicHeader(USER, ' pw-fake '))).ok).toBe(true)
    expect(basicAuth(req('/leads', basicHeader(USER, 'pw-fake'))).ok).toBe(false)
  })
})

describe('basicAuth — no VERCEL_ENV: a production build counts as deployed', () => {
  it.each([
    ['empty', ''],
    ['unset', undefined],
    ['only spaces', '  '],
  ])('503s /leads in a production build when the password is %s', (_label, value) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', value)
    expectNotConfigured(basicAuth(req('/leads')))
    expectNotConfigured(basicAuth(req('/api/leads', basicHeader(USER, ''))))
  })

  it('treats an empty VERCEL_ENV like a missing one', () => {
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expectNotConfigured(basicAuth(req('/leads')))
  })

  it('lets the exempt routes through in a production build with no password', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    for (const pathname of BASIC_AUTH_EXEMPT_PATHS) {
      expect(basicAuth(req(pathname)).ok).toBe(true)
    }
  })

  it('keeps the no-prompt path in next dev (NODE_ENV=development): local dev and E2E', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('keeps the no-prompt path under vitest (NODE_ENV=test)', () => {
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('an explicit VERCEL_ENV=development wins over a production build (no prompt)', () => {
    vi.stubEnv('VERCEL_ENV', 'development')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', '')
    expect(basicAuth(req('/leads')).ok).toBe(true)
  })

  it('a production build with a password set asks for it as usual', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BASIC_AUTH_PASSWORD', PASSWORD)
    const prompt = basicAuth(req('/leads'))
    if (prompt.ok) throw new Error('expected the Basic prompt')
    expect(prompt.response.status).toBe(401)
    expect(basicAuth(req('/leads', basicHeader(USER, PASSWORD))).ok).toBe(true)
  })
})
