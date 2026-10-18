import { prisma } from '../../prisma'
import {
  getDecryptedAccessToken,
  getDecryptedRefreshToken,
  updateAccessToken,
} from '../oauth/store'
import { refreshAccessToken } from '../oauth/graph'
import { createGraphSyncPorts } from '../email/graph-adapter'
import { deltaSync, type SyncResult } from '../email/gmail-sync'
import { graphEnabled } from '../graph-switch'
import { logger } from '../../logger'

/**
 * Graph mirror of gmail-runner: load a msft-graph credential, refresh the token if
 * stale, and run a delta sync. Graph's cursor is the `@odata.deltaLink`
 * (`graphDeltaLink`); an empty cursor triggers the initial full delta.
 */
export async function runGraphSyncForCredential(
  credentialId: string,
): Promise<SyncResult | { skipped: true }> {
  // Brief 41.2: Outlook is paused (Ryan's instruction). Drop the job before the
  // credential is read: no refresh, no Graph call, and no error, so pg-boss
  // doesn't retry it after the switch flips (engineering precaution, as
  // outbound-email drops sends while email is off).
  if (!graphEnabled()) {
    logger.warn({ credentialId }, 'graph sync job dropped: Outlook is paused (GRAPH_ENABLED)')
    return { skipped: true }
  }

  const cred = await prisma.oAuthCredential.findUnique({ where: { id: credentialId } })
  if (!cred || cred.provider !== 'msft-graph' || cred.status !== 'active') {
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

  const ports = createGraphSyncPorts({
    orgId: cred.organizationId,
    credentialId: cred.id,
    connectedEmail: cred.emailAddress ?? '',
    accessToken,
  })
  return deltaSync(ports, cred.graphDeltaLink ?? '')
}
