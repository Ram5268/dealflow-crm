import { signState } from './state'
import { graphEnabled, GraphDisabledError } from '../graph-switch'

/**
 * Microsoft Graph OAuth (brief §M5). Mirrors oauth/gmail.ts but via the MSFT
 * identity v2.0 REST endpoints (fetch) rather than an SDK — same mockable pattern
 * as the Twilio client, no extra dependency. A SEPARATE app registration from
 * DealFlow's read-only Graph token. provider = 'msft-graph' on the credential.
 *
 * Bases are env-overridable so isolation tests point at the Graph mock:
 * MSFT_IDENTITY_BASE (token/authorize), GRAPH_API_BASE / GRAPH_MOCK_URL (/me).
 *
 * Brief 41.2: while Outlook is paused (Ryan's instruction) there is no sign-in
 * link, code exchange or token refresh; each refuses before calling Microsoft.
 */
export const GRAPH_SCOPES = ['offline_access', 'Mail.Read', 'Mail.Send', 'User.Read']

const identityBase = () => process.env.MSFT_IDENTITY_BASE ?? 'https://login.microsoftonline.com'
const graphBase = () =>
  process.env.GRAPH_MOCK_URL ?? process.env.GRAPH_API_BASE ?? 'https://graph.microsoft.com/v1.0'
const tenant = () => process.env.MSFT_GRAPH_TENANT_ID ?? 'common'

export function getAuthUrl(orgId: string): string {
  if (!graphEnabled()) throw new GraphDisabledError()
  const params = new URLSearchParams({
    client_id: process.env.MSFT_GRAPH_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: process.env.MSFT_GRAPH_REDIRECT_URI ?? '',
    response_mode: 'query',
    scope: GRAPH_SCOPES.join(' '),
    state: signState({ orgId, provider: 'msft-graph' }),
  })
  return `${identityBase()}/${tenant()}/oauth2/v2.0/authorize?${params.toString()}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${identityBase()}/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) throw new Error(`msft token request failed: HTTP ${res.status}`)
  return (await res.json()) as TokenResponse
}

export interface ExchangedTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scope?: string
  emailAddress: string
}

export async function exchangeCode(code: string): Promise<ExchangedTokens> {
  if (!graphEnabled()) throw new GraphDisabledError()
  const t = await tokenRequest({
    client_id: process.env.MSFT_GRAPH_CLIENT_ID ?? '',
    client_secret: process.env.MSFT_GRAPH_CLIENT_SECRET ?? '',
    code,
    redirect_uri: process.env.MSFT_GRAPH_REDIRECT_URI ?? '',
    grant_type: 'authorization_code',
    scope: GRAPH_SCOPES.join(' '),
  })
  if (!t.access_token) throw new Error('msft token exchange returned no access_token')

  const meRes = await fetch(`${graphBase()}/me`, {
    headers: { authorization: `Bearer ${t.access_token}` },
  })
  const profile = meRes.ok
    ? ((await meRes.json()) as { mail?: string; userPrincipalName?: string })
    : {}
  const emailAddress = profile.mail ?? profile.userPrincipalName
  if (!emailAddress) throw new Error('msft /me returned no email address')

  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : undefined,
    scope: t.scope,
    emailAddress,
  }
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt?: Date }> {
  if (!graphEnabled()) throw new GraphDisabledError()
  const t = await tokenRequest({
    client_id: process.env.MSFT_GRAPH_CLIENT_ID ?? '',
    client_secret: process.env.MSFT_GRAPH_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: GRAPH_SCOPES.join(' '),
  })
  if (!t.access_token) throw new Error('msft token refresh returned no access token')
  return {
    accessToken: t.access_token,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : undefined,
  }
}
