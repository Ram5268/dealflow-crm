import { describe, it, expect, beforeAll } from 'vitest'
import { getAuthUrl, GMAIL_SCOPES } from './gmail'
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
