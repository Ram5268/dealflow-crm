import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})

afterEach(() => {
  // Restore rather than delete: the gate is env-driven and this suite shares a
  // process with every other file (vitest.config sets isolate: false).
  if (ORIGINAL_USER === undefined) delete process.env.BASIC_AUTH_USER
  else process.env.BASIC_AUTH_USER = ORIGINAL_USER
  if (ORIGINAL_PASSWORD === undefined) delete process.env.BASIC_AUTH_PASSWORD
  else process.env.BASIC_AUTH_PASSWORD = ORIGINAL_PASSWORD
})

describe('basicAuth — disabled when no password is configured', () => {
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
