import { prisma } from '@/lib/prisma'
import type { DerivedSignalUpsert } from './sync'

// ─────────────────────────────────────────────────────────────────────────────
// Upserts DealFlowDerivedSignal rows (keyed by mojoId) and promotes the
// ammunition onto matching Lead rows (by mojoId). Both writes target the CRM's
// OWN DB (dealflow_crm) — never DealFlow's. Idempotent: re-running with the same
// batch converges to the same state.
// ─────────────────────────────────────────────────────────────────────────────

export interface PromoteResult {
  signalsUpserted: number
  leadsPromoted: number
}

export async function upsertSignals(
  organizationId: string,
  signals: DerivedSignalUpsert[]
): Promise<number> {
  let count = 0
  for (const s of signals) {
    await prisma.dealFlowDerivedSignal.upsert({
      where: { mojoId: s.mojoId },
      create: {
        organizationId,
        mojoId: s.mojoId,
        queueRank: s.queueRank,
        priorityScore: s.priorityScore,
        queueReason: s.queueReason,
        primaryMatchId: s.primaryMatchId,
        primaryMatchFit: s.primaryMatchFit,
        primaryCaptureStatus: s.primaryCaptureStatus,
        primaryMatchConfidence: s.primaryMatchConfidence,
        dealflowRawJson: s.dealflowRawJson as object,
      },
      update: {
        queueRank: s.queueRank,
        priorityScore: s.priorityScore,
        queueReason: s.queueReason,
        primaryMatchId: s.primaryMatchId,
        primaryMatchFit: s.primaryMatchFit,
        primaryCaptureStatus: s.primaryCaptureStatus,
        primaryMatchConfidence: s.primaryMatchConfidence,
        dealflowRawJson: s.dealflowRawJson as object,
        syncedAt: new Date(),
      },
    })
    count++
  }
  return count
}

// Promotes ammunition onto the matching Lead (by mojoId). Leads that don't exist
// yet in the CRM (contact not imported) are simply skipped — the signal is still
// stored and will apply once the Lead is imported and re-synced.
export async function promoteToLeads(
  organizationId: string,
  signals: DerivedSignalUpsert[]
): Promise<number> {
  let promoted = 0
  const now = new Date()
  for (const s of signals) {
    const res = await prisma.lead.updateMany({
      where: { organizationId, mojoId: s.mojoId },
      data: {
        priorityScore: s.priorityScore,
        topMatchFit: s.primaryMatchFit,
        captureStatus: s.primaryCaptureStatus,
        matchReason: s.matchReason,
        dealflowDeepLink: s.dealflowDeepLink,
        dealflowSignalSyncedAt: now,
      },
    })
    promoted += res.count
  }
  return promoted
}

export async function promote(
  organizationId: string,
  signals: DerivedSignalUpsert[]
): Promise<PromoteResult> {
  const signalsUpserted = await upsertSignals(organizationId, signals)
  const leadsPromoted = await promoteToLeads(organizationId, signals)
  return { signalsUpserted, leadsPromoted }
}
