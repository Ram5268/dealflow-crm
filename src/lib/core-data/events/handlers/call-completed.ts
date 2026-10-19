import { prisma } from '@/lib/prisma'
import { recordCallCompleted } from '@/lib/core-data/activity/write'

// call.completed (channel crm_call, emitter B). Updates the Call Activity with
// disposition + duration + cost. `cost` is a decimal-as-string and is stored
// VERBATIM in the Activity body metadata — never Number(cost) at ingest.
//
// Brief 50 (PR 3): the write itself lives in core-data/activity/write.ts,
// shared with the Twilio status callback and the reconciliation job, which
// write it in the same transaction as the call's final status (that is what
// runs on Vercel; this LISTEN consumer only runs from the local
// scripts/boot-*.ts). A call with no entry yet is filed under its own Call
// row's organization, lead and contact; this handler used to guess "the first
// organization" with no lead.

export interface CallCompletedPayload {
  callId: string
  disposition: string
  duration: number | null
  cost: string | null
  outcomeId?: string | null
  correlationId: string
}

export async function onCallCompleted(p: Record<string, unknown>): Promise<void> {
  const payload = p as unknown as CallCompletedPayload
  await recordCallCompleted(prisma, {
    callId: payload.callId,
    disposition: payload.disposition,
    duration: payload.duration,
    cost: payload.cost,
    outcomeId: payload.outcomeId,
  })
}
