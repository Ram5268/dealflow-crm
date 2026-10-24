import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getCorrelationId } from '@/lib/shell/correlationId'
import { captureException } from '@/lib/shared/sentry'
import { logger } from '@/lib/logger'
import { fetchDealflowBatch, buildSignals, checkFreshness } from './sync'
import { applySync, countBatchMapping, refuseBatch, type ApplyResult, type BatchRefusal } from './write'
import { emit } from '@/lib/core-data/events/emit'

// Orchestrates one sync run: fetch (RO) → freshness guard → transform → one
// set-based write transaction → emit `lead.derived-signals-synced` on channel
// crm_lead_sync (no eventName field).
// On RO failure: nothing is written, error surfaced. On an empty or >36h-old
// DealFlow batch (Brief 37 freshness guard): nothing is written, `skipped` says why.
// Brief 50 (PR 11), engineering precautions (open item 6.10): only the DealFlow
// organization with this CRM organization's slug is read (sync.ts RO_SQL), and
// a batch that matches no lead of the organization, or fewer than half as many
// as the last morning's copy reached (Brief 50 PR 19: leads, not signal rows),
// writes nothing either (write.ts refuseBatch); `skipped` says which, as for
// an empty or stale batch.
// Brief 50 (PR 19): such a refusal answers the cron with 409 (syncHttpStatus
// below), and the Queue shows it (nightly-notice.ts readCopyRefusal).

export interface SyncRunResult extends ApplyResult {
  skipped?: 'empty' | 'stale' | BatchRefusal
  generationRunId: string | null
  generatedAt: string | null
  includeTestBuyers: boolean | null
  count: number // = signalsUpserted
  leadsPromoted: number // = leadsUpdated
  syncedAt: string
}

const NOTHING_WRITTEN: ApplyResult = {
  signalsUpserted: 0, signalsRemoved: 0, leadsUpdated: 0, leadsCleared: 0, timezonesSet: 0, viewCreated: false, windowSeeded: false,
}

const REFUSAL_LOG: Record<BatchRefusal, string> = {
  no_leads_matched: "dealflow sync skipped: DealFlow's call list matches no CRM lead, so nothing was written",
  too_few_leads_matched:
    "dealflow sync skipped: DealFlow's call list matches fewer than half as many CRM leads as the last morning's copy reached, so nothing was written",
}

// Brief 50 (PR 19), the planner's review (Revision 2): a refused copy answers
// the cron with a non-2xx code, so Vercel's cron log shows a failed run
// instead of a success (it answered 200 {ok:false}, which looked like one).
// 409 Conflict: the copy ran and chose not to write, because DealFlow's list
// conflicts with what the CRM holds (it reaches far fewer of the leads); it is
// not an outage. A 5xx would say the CRM or DealFlow was down, and 503 already
// means "DealFlow couldn't be read" on this route, so the log alone tells the
// two apart. Vercel doesn't retry a cron that fails, so the code changes
// nothing else. An empty or stale DealFlow list (DealFlow made no new list)
// stays 200 {ok:false} as before.
export const REFUSED_COPY_STATUS = 409

export function syncHttpStatus(result: Pick<SyncRunResult, 'skipped'>): number {
  return result.skipped === 'no_leads_matched' || result.skipped === 'too_few_leads_matched' ? REFUSED_COPY_STATUS : 200
}

export async function runDealflowSync(
  organizationId: string,
  now: Date = new Date(),
  db: PrismaClient = prisma
): Promise<SyncRunResult> {
  const correlationId = getCorrelationId() ?? 'cron'
  // The DealFlow organization to read is the one with this organization's slug.
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { slug: true } })
  if (!org) throw new Error('DealFlow sync: the CRM organization was not found, so nothing was read or written')
  let batch
  try {
    batch = await fetchDealflowBatch(org.slug, now)
  } catch (err) {
    captureException(err, { dependency: 'dealflow-ro', event: 'dealflow-signal-sync' })
    throw err // existing DealFlowDerivedSignal rows are untouched — never cleared
  }

  const syncedAt = now.toISOString()
  const fresh = checkFreshness(batch.rows, now)
  const run = {
    generationRunId: batch.rows[0]?.generation_run_id ?? null,
    generatedAt: fresh.generatedAt?.toISOString() ?? null,
    includeTestBuyers: batch.includeTestBuyers,
    syncedAt,
  }
  if (!fresh.ok) {
    logger.warn({ ...run, reason: fresh.reason }, 'dealflow sync skipped: DealFlow batch is empty or stale')
    return { ...run, skipped: fresh.reason, ...NOTHING_WRITTEN, count: 0, leadsPromoted: 0 }
  }

  const signals = buildSignals(batch)
  const mapping = await countBatchMapping(organizationId, signals, db)
  const refused = refuseBatch(mapping)
  if (refused) {
    logger.warn({ ...run, reason: refused, ...mapping }, REFUSAL_LOG[refused])
    return { ...run, skipped: refused, ...NOTHING_WRITTEN, count: 0, leadsPromoted: 0 }
  }

  const applied = await applySync(organizationId, signals, db)
  await emit('crm_lead_sync', {
    count: applied.signalsUpserted,
    syncedAt,
    correlationId,
  })
  return { ...run, ...applied, count: applied.signalsUpserted, leadsPromoted: applied.leadsUpdated }
}
