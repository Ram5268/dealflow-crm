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
  // The run claimImportCommit started; the commit only works while it holds
  // the import (Brief 41.1). Absent on jobs queued before run ids existed.
  runId?: string
}

// Enqueues the commit. With USE_PGBOSS=1 the job goes on the pg-boss queue for
// retryable, worker-driven processing. Otherwise it runs inline, and the
// returned promise settles when the commit does: the route runs this inside
// after(), so the platform keeps the function alive until the import finishes
// (Brief 41; a bare detached promise could be frozen mid-import). The route
// has already returned 202. commitImport marks the batch 'failed' on error.
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
  await runWithCorrelationId(job.correlationId, () =>
    commitImport(job.importBatchId, job.duplicateStrategy, job.mapping, job.correlationId, { runId: job.runId }).catch(
      (err) => captureException(err, { event: 'import-commit-inline' })
    )
  )
}
