import { runGmailSyncForCredential, resolveCredentialIdByEmail } from './gmail-runner'
import { logger } from '../../logger'

/**
 * pg-boss worker for `gmail-delta-sync`. Job carries either a `credentialId` (cron
 * path) or an `emailAddress` (Pub/Sub push path). Resolves to a credential and
 * runs the sync. Errors rethrow for pg-boss retry.
 */
export interface GmailDeltaJob {
  credentialId?: string
  emailAddress?: string
  orgId?: string
}

type Job = { data: GmailDeltaJob }

export async function handleGmailDeltaJob(input: Job | Job[]): Promise<void> {
  const jobs = Array.isArray(input) ? input : [input]
  for (const job of jobs) {
    let credentialId = job.data.credentialId
    if (!credentialId && job.data.emailAddress) {
      credentialId =
        (await resolveCredentialIdByEmail(job.data.orgId, job.data.emailAddress)) ?? undefined
    }
    if (!credentialId) {
      logger.warn({ data: job.data }, 'gmail-delta: no credential resolved; skipping')
      continue
    }
    await runGmailSyncForCredential(credentialId)
  }
}
