import { runGraphSyncForCredential } from './graph-runner'
import { logger } from '../../logger'

/** pg-boss worker for `graph-delta-sync`. Job carries a `credentialId`. */
export interface GraphDeltaJob {
  credentialId: string
}
type Job = { data: GraphDeltaJob }

export async function handleGraphDeltaJob(input: Job | Job[]): Promise<void> {
  const jobs = Array.isArray(input) ? input : [input]
  for (const job of jobs) {
    if (!job.data.credentialId) {
      logger.warn({ data: job.data }, 'graph-delta: no credentialId; skipping')
      continue
    }
    await runGraphSyncForCredential(job.data.credentialId)
  }
}
