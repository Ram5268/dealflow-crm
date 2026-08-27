import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock googleapis so exchangeCode/refreshAccessToken run without network. (getAuthUrl
// is covered against the real SDK in gmail.test.ts — different file, different mock scope.)
const h = vi.hoisted(() => ({
  getToken: vi.fn(),
  getAccessToken: vi.fn(),
  getProfile: vi.fn(),
}))

vi.mock('googleapis', () => {
  class OAuth2 {
    credentials: Record<string, unknown> = {}
    getToken = h.getToken
    getAccessToken = h.getAccessToken
    setCredentials(c: Record<string, unknown>) {
      this.credentials = { ...c, expiry_date: 222 }
    }
  }
  return {
    google: {
      auth: { OAuth2 },
      gmail: () => ({ users: { getProfile: h.getProfile } }),
    },
  }
})

import { exchangeCode, refreshAccessToken } from './gmail'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GOOGLE_CLIENT_ID = 'id'
  process.env.GOOGLE_CLIENT_SECRET = 'secret'
  process.env.GOOGLE_REDIRECT_URI = 'https://x/callback'
})

describe('exchangeCode', () => {
  it('returns tokens + the connected email', async () => {
    h.getToken.mockResolvedValue({
      tokens: { access_token: 'AT', refresh_token: 'RT', expiry_date: 999, scope: 's' },
    })
    h.getProfile.mockResolvedValue({ data: { emailAddress: 'ryan@example.com' } })

    const r = await exchangeCode('code123')
    expect(r).toMatchObject({
      accessToken: 'AT',
      refreshToken: 'RT',
      emailAddress: 'ryan@example.com',
      scope: 's',
    })
    expect(r.expiresAt).toEqual(new Date(999))
  })

  it('throws when the exchange returns no access_token', async () => {
    h.getToken.mockResolvedValue({ tokens: {} })
    await expect(exchangeCode('c')).rejects.toThrow(/no access_token/)
  })

  it('throws when getProfile returns no emailAddress', async () => {
    h.getToken.mockResolvedValue({ tokens: { access_token: 'AT' } })
    h.getProfile.mockResolvedValue({ data: {} })
    await expect(exchangeCode('c')).rejects.toThrow(/no emailAddress/)
  })
})

describe('refreshAccessToken', () => {
  it('mints a fresh access token + expiry', async () => {
    h.getAccessToken.mockResolvedValue({ token: 'AT2' })
    const r = await refreshAccessToken('RT')
    expect(r.accessToken).toBe('AT2')
    expect(r.expiresAt).toEqual(new Date(222))
  })

  it('throws when no token comes back', async () => {
    h.getAccessToken.mockResolvedValue({})
    await expect(refreshAccessToken('RT')).rejects.toThrow(/no access token/)
  })
})
