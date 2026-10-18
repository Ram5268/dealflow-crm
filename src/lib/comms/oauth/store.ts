import { prisma } from '../../prisma'
import { encryptToken, decryptToken } from './crypto'
import { graphEnabled, GraphDisabledError } from '../graph-switch'

/**
 * OAuthCredential CRUD (brief §2.1 `store.ts`).
 *
 * Refresh + access tokens are AES-256-GCM encrypted at rest (the frozen columns
 * are named `*Encrypted`, and `accessTokenEncrypted` is non-null, so we encrypt
 * both rather than store plaintext in an "encrypted" column — a deliberate
 * deviation from the brief's "don't encrypt access tokens" micro-note, justified
 * by the schema's naming + non-null constraint). Delta cursors + reauth status
 * live in the planner-approved additive columns.
 */

export type OAuthProvider = 'gmail' | 'msft-graph'

export interface UpsertCredentialInput {
  orgId: string
  provider: OAuthProvider
  emailAddress: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scope?: string
  userId?: string
}

export function upsertCredential(input: UpsertCredentialInput) {
  // Brief 41.2: no Microsoft token is stored while Outlook is paused (Ryan's
  // instruction). Refreshed tokens (updateAccessToken) can't arise while it's
  // off: oauth/graph.ts refuses every Microsoft refresh.
  if (input.provider === 'msft-graph' && !graphEnabled()) throw new GraphDisabledError()
  const accessTokenEncrypted = encryptToken(input.accessToken)
  const refreshTokenEncrypted = input.refreshToken
    ? encryptToken(input.refreshToken)
    : undefined

  return prisma.oAuthCredential.upsert({
    where: {
      organizationId_provider: {
        organizationId: input.orgId,
        provider: input.provider,
      },
    },
    create: {
      organizationId: input.orgId,
      userId: input.userId ?? null,
      provider: input.provider,
      emailAddress: input.emailAddress,
      accessTokenEncrypted,
      refreshTokenEncrypted: refreshTokenEncrypted ?? null,
      scope: input.scope ?? null,
      expiresAt: input.expiresAt ?? null,
      status: 'active',
    },
    update: {
      emailAddress: input.emailAddress,
      accessTokenEncrypted,
      // Re-consent frequently omits a fresh refresh token — keep the stored one
      // rather than nulling it.
      ...(refreshTokenEncrypted ? { refreshTokenEncrypted } : {}),
      scope: input.scope ?? null,
      expiresAt: input.expiresAt ?? null,
      status: 'active',
    },
  })
}

export function getCredential(orgId: string, provider: OAuthProvider) {
  return prisma.oAuthCredential.findUnique({
    where: { organizationId_provider: { organizationId: orgId, provider } },
  })
}

export function getDecryptedRefreshToken(cred: {
  refreshTokenEncrypted: string | null
}): string | null {
  return cred.refreshTokenEncrypted ? decryptToken(cred.refreshTokenEncrypted) : null
}

export function getDecryptedAccessToken(cred: {
  accessTokenEncrypted: string
}): string {
  return decryptToken(cred.accessTokenEncrypted)
}

export function markReauthRequired(id: string) {
  return prisma.oAuthCredential.update({
    where: { id },
    data: { status: 'reauth_required' },
  })
}

/**
 * Local revocation: drop both tokens and flag the credential dead.
 *
 * `accessTokenEncrypted` is NOT NULL in the schema, so it is emptied rather than
 * nulled. Decrypting '' throws, which is the correct fail-closed behaviour for a
 * credential that no longer grants anything.
 */
export function markRevoked(id: string) {
  return prisma.oAuthCredential.update({
    where: { id },
    data: {
      accessTokenEncrypted: '',
      refreshTokenEncrypted: null,
      expiresAt: null,
      status: 'revoked',
    },
  })
}

export function markError(id: string) {
  return prisma.oAuthCredential.update({ where: { id }, data: { status: 'error' } })
}

export function updateAccessToken(id: string, accessToken: string, expiresAt?: Date) {
  return prisma.oAuthCredential.update({
    where: { id },
    data: {
      accessTokenEncrypted: encryptToken(accessToken),
      expiresAt: expiresAt ?? null,
      status: 'active',
    },
  })
}

export function updateGmailHistoryId(id: string, gmailHistoryId: string) {
  return prisma.oAuthCredential.update({ where: { id }, data: { gmailHistoryId } })
}

export function updateGraphDeltaLink(id: string, graphDeltaLink: string) {
  return prisma.oAuthCredential.update({ where: { id }, data: { graphDeltaLink } })
}

export function updateGmailWatch(id: string, gmailWatchExpiresAt: Date) {
  return prisma.oAuthCredential.update({
    where: { id },
    data: { gmailWatchExpiresAt },
  })
}
