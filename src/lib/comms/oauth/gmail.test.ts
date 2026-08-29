import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { getAuthUrl, GMAIL_SCOPES, revokeToken } from './gmail'
import { verifyState } from './state'

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret'
  process.env.GOOGLE_REDIRECT_URI = 'https://crm.example.com/api/comms/oauth/gmail/callback'
  process.env.OAUTH_STATE_SECRET = 'test-state-secret'
})

describe('getAuthUrl', () => {
  it('builds a Google consent URL with offline access and both scopes', () => {
    const url = new URL(getAuthUrl('org_42'))
    expect(url.origin + url.pathname).toContain('accounts.google.com')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID)
    const scope = url.searchParams.get('scope') ?? ''
    for (const s of GMAIL_SCOPES) expect(scope).toContain(s)
  })

  it('carries a verifiable, org-bound state', () => {
    const url = new URL(getAuthUrl('org_42'))
    const state = url.searchParams.get('state')!
    expect(verifyState(state, { secret: 'test-state-secret' })).toEqual({
      orgId: 'org_42',
      provider: 'gmail',
    })
  })
})

describe('revokeToken', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(status: number, body = '') {
    const fetchMock = vi.fn(async () => new Response(body, { status }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('POSTs the token as form-encoded to the Google revoke endpoint', async () => {
    const fetchMock = stubFetch(200)
    await revokeToken('refresh-abc')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://oauth2.googleapis.com/revoke')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toBe('token=refresh-abc')
  })

  it('treats an already-dead token as success (idempotent disconnect)', async () => {
    stubFetch(400, '{"error":"invalid_token"}')
    await expect(revokeToken('dead')).resolves.toBeUndefined()
  })

  it('throws on any other provider failure so the route can 502', async () => {
    stubFetch(500, 'upstream boom')
    await expect(revokeToken('t')).rejects.toThrow(/revocation failed \(500\)/)
  })
})
