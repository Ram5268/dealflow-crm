import { logger } from '@/lib/logger'

// scrub.completed (channel crm_scrub, emitter C). HANDLER DELETED per review
// (brief §6): the payload carries no phone list, so there is no principled Lead
// reaction. Compliance is enforced inline in /api/queue. This handler ONLY logs
// for observability — no Lead writes, no cross-ownership ScrubLog reads.

export async function onScrubCompleted(p: Record<string, unknown>): Promise<void> {
  logger.info({ correlationId: p.correlationId }, 'scrub.completed observed')
}

// pacing-update is likewise a no-op: recognized shape, debug line, return.
export async function onPacingUpdate(p: Record<string, unknown>): Promise<void> {
  logger.debug({ correlationId: p.correlationId }, 'pacing update ignored')
}
