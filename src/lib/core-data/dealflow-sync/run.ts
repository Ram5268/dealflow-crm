import { getCorrelationId } from '@/lib/shell/correlationId'
import { captureException } from '@/lib/shared/sentry'
import { logger } from '@/lib/logger'
import { fetchDealflowBatch, buildSignals, checkFreshness } from './sync'
import { applySync, type ApplyResult } from './write'
import { emit } from '@/lib/core-data/events/emit'

// Orchestrates one sync run: fetch (RO) → freshness guard → transform → one
// set-based write transaction → emit `lead.derived-signals-synced` on channel
// crm_lead_sync (no eventName field).
// On RO failure: nothing is written, error surfaced. On an empty or >36h-old
// DealFlow batch (Brief 37 freshness guard): nothing is written, `skipped` says why.

export interface SyncRunResult extends ApplyResult {
  skipped?: 'empty' | 'stale'
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

export async function runDealflowSync(
  organizationId: string,
  now: Date = new Date()
): Promise<SyncRunResult> {
  const correlationId = getCorrelationId() ?? 'cron'
  let batch
  try {
    batch = await fetchDealflowBatch(now)
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

  const applied = await applySync(organizationId, buildSignals(batch))
  await emit('crm_lead_sync', {
    count: applied.signalsUpserted,
    syncedAt,
    correlationId,
  })
  return { ...run, ...applied, count: applied.signalsUpserted, leadsPromoted: applied.leadsUpdated }
}
