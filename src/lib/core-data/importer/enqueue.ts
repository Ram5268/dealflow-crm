import { runWithCorrelationId } from '@/lib/shell/correlationId'
import { captureException } from '@/lib/shared/sentry'
import { getBoss, QUEUES, bossEnabled } from '@/lib/core-data/events/pg-boss'
import { commitImport, type DuplicateStrategy } from './commit-worker'
import type { MappingProposal } from './ai-mapping'

export interface ImportCommitJob {
  importBatchId: string
  duplicateStrategy: DuplicateStrategy
  mapping: MappingProposal
  correlationId: string
}

// Enqueues the commit. With USE_PGBOSS=1 the job goes on the pg-boss queue for
// retryable, worker-driven processing. Otherwise (isolated build) it runs
// detached inline so the route still returns 202 immediately.
export async function enqueueImportCommit(job: ImportCommitJob): Promise<void> {
  if (bossEnabled()) {
    try {
      const boss = await getBoss()
      await boss.send(QUEUES.importCommit, job)
      return
    } catch (err) {
      captureException(err, { event: 'enqueue-import-commit', dependency: 'pg-boss' })
      // fall through to inline
    }
  }
  void runWithCorrelationId(job.correlationId, () =>
    commitImport(job.importBatchId, job.duplicateStrategy, job.mapping, job.correlationId).catch(
      (err) => captureException(err, { event: 'import-commit-inline' })
    )
  )
}
