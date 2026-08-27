import { getBoss, QUEUES } from '@/lib/core-data/events/pg-boss'
import { runWithCorrelationId } from '@/lib/shell/correlationId'
import { logger } from '@/lib/logger'
import { commitImport } from './commit-worker'
import type { ImportCommitJob } from './enqueue'

// Registers the pg-boss worker that runs import.commit jobs with retry semantics.
// Called by boot-standalone; the routes only enqueue.
export async function startImportWorker(): Promise<void> {
  const boss = await getBoss()
  await boss.work<ImportCommitJob>(QUEUES.importCommit, async ([job]) => {
    const { importBatchId, duplicateStrategy, mapping, correlationId } = job.data
    await runWithCorrelationId(correlationId, () =>
      commitImport(importBatchId, duplicateStrategy, mapping, correlationId)
    )
    logger.info({ importBatchId }, 'import.commit job done')
  })
  logger.info('import.commit worker registered')
}
