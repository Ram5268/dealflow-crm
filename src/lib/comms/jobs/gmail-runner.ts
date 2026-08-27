import { prisma } from '../../prisma'
import {
  getDecryptedAccessToken,
  getDecryptedRefreshToken,
  updateAccessToken,
} from '../oauth/store'
import { refreshAccessToken } from '../oauth/gmail'
import { createGmailSyncPorts } from '../email/gmail-adapter'
import { deltaSync, fullBackfill, type SyncResult } from '../email/gmail-sync'

/**
 * Loads a Gmail credential, refreshes its access token if stale, and runs a delta
 * sync (or an initial backfill if there's no cursor yet). Called by the
 * gmail-delta-sync worker + the cron endpoint.
 */
const BACKFILL_SINCE = '2026/01/01'

export async function runGmailSyncForCredential(
  credentialId: string,
): Promise<SyncResult | { skipped: true }> {
  const cred = await prisma.oAuthCredential.findUnique({ where: { id: credentialId } })
  if (!cred || cred.provider !== 'gmail' || cred.status !== 'active') {
    return { skipped: true }
  }

  let accessToken = getDecryptedAccessToken(cred)
  const refreshToken = getDecryptedRefreshToken(cred)
  const expired = !cred.expiresAt || cred.expiresAt.getTime() < Date.now() + 60_000
  if (refreshToken && expired) {
    const r = await refreshAccessToken(refreshToken)
    accessToken = r.accessToken
    await updateAccessToken(cred.id, r.accessToken, r.expiresAt)
  }

  const ports = createGmailSyncPorts({
    orgId: cred.organizationId,
    credentialId: cred.id,
    connectedEmail: cred.emailAddress ?? '',
    accessToken,
  })

  return cred.gmailHistoryId
    ? deltaSync(ports, cred.gmailHistoryId)
    : fullBackfill(ports, BACKFILL_SINCE)
}

export async function resolveCredentialIdByEmail(
  orgId: string | undefined,
  emailAddress: string,
): Promise<string | null> {
  const cred = await prisma.oAuthCredential.findFirst({
    where: { provider: 'gmail', emailAddress, ...(orgId ? { organizationId: orgId } : {}) },
    select: { id: true },
  })
  return cred?.id ?? null
}
