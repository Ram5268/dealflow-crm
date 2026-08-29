import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/shell/orgContext'
import {
  getCredential,
  getDecryptedRefreshToken,
  getDecryptedAccessToken,
  markRevoked,
  type OAuthProvider,
} from '@/lib/comms/oauth/store'
import { revokeToken as revokeGmailToken } from '@/lib/comms/oauth/gmail'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ provider: string }> }

// URL-facing name -> the value stored in OAuthCredential.provider.
const PROVIDERS: Record<string, OAuthProvider> = {
  gmail: 'gmail',
  outlook: 'msft-graph',
}

/**
 * Disconnect a connected mailbox (Settings > Connected Accounts, M5).
 *
 * Single-user assumption still holds — the credential is resolved by org, not by
 * session. TODO: auth wiring — gate on the signed-in user once auth exists.
 *
 * Provider-side revocation is asymmetric:
 *   - Gmail  -> RFC 7009 revoke at https://oauth2.googleapis.com/revoke.
 *   - Outlook-> the Microsoft identity platform (AAD v2) exposes NO RFC 7009
 *     endpoint. Graph's `POST /me/revokeSignInSessions` is the nearest thing and
 *     needs a scope this app does not hold (D requests offline_access, Mail.Read,
 *     Mail.Send, User.Read). So Outlook is revoked LOCALLY only, and the response
 *     says so via `remoteRevocation: false` rather than implying otherwise.
 *
 * On provider failure: 502 and the DB is left untouched, so the UI keeps showing
 * the account as connected instead of lying about a disconnect that did not land.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const organizationId = await getCurrentOrgId()
  const { provider } = await ctx.params

  const stored = PROVIDERS[provider]
  if (!stored) {
    return NextResponse.json(
      { error: 'unknown_provider', expected: Object.keys(PROVIDERS) },
      { status: 404 },
    )
  }

  const cred = await getCredential(organizationId, stored)
  if (!cred) {
    return NextResponse.json({ error: 'not_connected' }, { status: 404 })
  }
  // Idempotent: a second disconnect is a no-op, not a decrypt failure.
  if (cred.status === 'revoked') {
    return NextResponse.json({ revoked: true, provider, alreadyRevoked: true })
  }

  const remoteRevocation = stored === 'gmail'
  if (remoteRevocation) {
    let token: string
    try {
      token = getDecryptedRefreshToken(cred) ?? getDecryptedAccessToken(cred)
    } catch (err) {
      logger.error({ err, provider }, 'oauth revoke: stored token failed to decrypt')
      return NextResponse.json({ error: 'token_decrypt_failed' }, { status: 502 })
    }
    try {
      await revokeGmailToken(token)
    } catch (err) {
      logger.error({ err, provider }, 'oauth revoke: provider rejected revocation')
      return NextResponse.json({ error: 'provider_revocation_failed' }, { status: 502 })
    }
  }

  await markRevoked(cred.id)
  logger.info({ provider, remoteRevocation }, 'oauth credential revoked')
  return NextResponse.json({ revoked: true, provider, remoteRevocation })
}
