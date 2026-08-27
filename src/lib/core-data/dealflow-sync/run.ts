import { getCorrelationId } from '@/lib/shell/correlationId'
import { captureException } from '@/lib/shared/sentry'
import { fetchDealflowRows, buildSignals } from './sync'
import { promote } from './promote'
import { emit } from '@/lib/core-data/events/emit'

// Orchestrates one sync run: fetch (RO) → transform → upsert + promote → emit
// `lead.derived-signals-synced` on channel crm_lead_sync (no eventName field).
// On RO failure: existing signals are preserved (no delete), error surfaced.

export interface SyncRunResult {
  count: number
  leadsPromoted: number
  syncedAt: string
}

export async function runDealflowSync(organizationId: string): Promise<SyncRunResult> {
  const correlationId = getCorrelationId() ?? 'cron'
  let rows
  try {
    rows = await fetchDealflowRows()
  } catch (err) {
    captureException(err, { dependency: 'dealflow-ro', event: 'dealflow-signal-sync' })
    throw err // existing DealFlowDerivedSignal rows are untouched — never cleared
  }

  const signals = buildSignals(rows)
  const { signalsUpserted, leadsPromoted } = await promote(organizationId, signals)

  const syncedAt = new Date().toISOString()
  await emit('crm_lead_sync', {
    count: signalsUpserted,
    syncedAt,
    correlationId,
  })

  return { count: signalsUpserted, leadsPromoted, syncedAt }
}
