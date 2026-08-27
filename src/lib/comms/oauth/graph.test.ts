import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getAuthUrl, exchangeCode, refreshAccessToken, GRAPH_SCOPES } from './graph'
import { verifyState } from './state'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  process.env.MSFT_GRAPH_CLIENT_ID = 'client-id'
  process.env.MSFT_GRAPH_CLIENT_SECRET = 'secret'
  process.env.MSFT_GRAPH_REDIRECT_URI = 'https://crm/api/comms/oauth/msft/callback'
  process.env.MSFT_GRAPH_TENANT_ID = 'common'
  process.env.OAUTH_STATE_SECRET = 'state-secret'
  delete process.env.GRAPH_MOCK_URL
  delete process.env.GRAPH_API_BASE
  delete process.env.MSFT_IDENTITY_BASE
})
afterEach(() => vi.unstubAllGlobals())

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('getAuthUrl', () => {
  it('builds an MSFT authorize URL with scopes + verifiable state', () => {
    const url = new URL(getAuthUrl('org_9'))
    expect(url.href).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('response_type')).toBe('code')
    const scope = url.searchParams.get('scope') ?? ''
    for (const s of GRAPH_SCOPES) expect(scope).toContain(s)
    expect(verifyState(url.searchParams.get('state')!, { secret: 'state-secret' })).toEqual({
      orgId: 'org_9',
      provider: 'msft-graph',
    })
  })
})

describe('exchangeCode', () => {
  it('exchanges the code then resolves the email from /me', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'Mail.Read' }))
      .mockResolvedValueOnce(ok({ mail: 'ryan@elliman.com', userPrincipalName: 'ryan@elliman.onmicrosoft.com' }))
    const r = await exchangeCode('code')
    expect(r).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', scope: 'Mail.Read', emailAddress: 'ryan@elliman.com' })
    expect(r.expiresAt).toBeInstanceOf(Date)
    // token endpoint first, then /me
    expect(String(fetchMock.mock.calls[0][0])).toContain('/oauth2/v2.0/token')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/me')
  })

  it('falls back to userPrincipalName when mail is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'AT' }))
      .mockResolvedValueOnce(ok({ userPrincipalName: 'ryan@elliman.onmicrosoft.com' }))
    expect((await exchangeCode('c')).emailAddress).toBe('ryan@elliman.onmicrosoft.com')
  })

  it('throws when the exchange returns no access token', async () => {
    fetchMock.mockResolvedValueOnce(ok({}))
    await expect(exchangeCode('c')).rejects.toThrow(/no access_token/)
  })

  it('throws when /me yields no email', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'AT' })).mockResolvedValueOnce(ok({}))
    await expect(exchangeCode('c')).rejects.toThrow(/no email/)
  })

  it('throws on a non-2xx token response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
    await expect(exchangeCode('c')).rejects.toThrow(/HTTP 400/)
  })
})

describe('refreshAccessToken', () => {
  it('mints a fresh access token', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'AT2', expires_in: 3600 }))
    const r = await refreshAccessToken('RT')
    expect(r.accessToken).toBe('AT2')
    expect(r.expiresAt).toBeInstanceOf(Date)
  })

  it('throws when no token comes back', async () => {
    fetchMock.mockResolvedValueOnce(ok({}))
    await expect(refreshAccessToken('RT')).rejects.toThrow(/no access token/)
  })
})
