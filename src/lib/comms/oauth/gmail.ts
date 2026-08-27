import { google } from 'googleapis'
import { signState } from './state'

/**
 * Gmail OAuth flow + token refresh (brief §2.1 `oauth/gmail.ts`).
 *
 * A SEPARATE OAuth app from DealFlow's read-only Graph token. Scopes: read + send
 * (brief §3). `access_type=offline` + `prompt=consent` so we reliably get a
 * refresh token. `getAuthUrl` is offline/pure enough to unit-test; the network
 * calls (`exchangeCode`, `refreshAccessToken`) are exercised via the Gmail mock
 * at Gate 1.
 */

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  )
}

/** Consent-screen URL carrying a signed, CSRF-safe `state`. */
export function getAuthUrl(orgId: string): string {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    include_granted_scopes: true,
    state: signState({ orgId, provider: 'gmail' }),
  })
}

export interface ExchangedTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scope?: string
  emailAddress: string
}

/** Exchange an authorization code; resolves the connected email via getProfile. */
export async function exchangeCode(code: string): Promise<ExchangedTokens> {
  const client = oauthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.access_token) {
    throw new Error('Gmail token exchange returned no access_token')
  }
  client.setCredentials(tokens)

  const gmail = google.gmail({ version: 'v1', auth: client })
  const profile = await gmail.users.getProfile({ userId: 'me' })
  const emailAddress = profile.data.emailAddress
  if (!emailAddress) {
    throw new Error('Gmail getProfile returned no emailAddress')
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    scope: tokens.scope ?? undefined,
    emailAddress,
  }
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt?: Date }> {
  const client = oauthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { token } = await client.getAccessToken()
  if (!token) {
    throw new Error('Gmail token refresh returned no access token')
  }
  const expiry = client.credentials.expiry_date
  return { accessToken: token, expiresAt: expiry ? new Date(expiry) : undefined }
}
