import { addInternalDnc, internalDncHits, normalizeE164, type InternalDncDb } from '@/lib/compliance/dnc/internal'
import { toE164 } from '@/lib/shared/phone'
import { classifyOptOut, type OptOutMatch } from './opt-out'
import { STOP_REASON } from './stop-handler'

/**
 * Brief 41.1 (F5): the sweep for lost STOPs. The webhook saves an inbound text
 * before it records the opt-out, and answers 500 if the opt-out write fails.
 * Twilio doesn't redeliver after a 5xx unless the webhook URL's retry settings
 * ask it to (docs/10dlc-status.md), so such a STOP stays saved with no opt-out.
 * This finds saved inbound texts that read as opt-outs (./opt-out.ts) whose
 * sender has no internal opt-out row, and adds one per number.
 * scripts/brief41-1-stop-sweep.ts runs it (dry run by default).
 */

export interface InboundSmsRow {
  id: string
  organizationId: string
  smsRemotePhone: string | null
  fromAddress: string
  bodyText: string | null
  dateCreated: Date
}

export interface StopSweepDb extends InternalDncDb {
  message: { findMany: (args: any) => Promise<InboundSmsRow[]> }
}

export interface MissingOptOut {
  messageId: string // the earliest opt-out text from this number
  organizationId: string
  phone: string // canonical E.164 (never printed by the script)
  match: OptOutMatch
}

export interface StopSweepPlan {
  inboundTexts: number
  optOutTexts: number
  optOutNumbers: number // distinct numbers (per org) that sent them
  alreadyOnList: number // of those numbers, already on the opt-out list
  missing: MissingOptOut[] // the rest: one per number
  unreadableSender: string[] // message ids whose sender isn't a phone number
}

const PAGE = 1000

// Every saved inbound text, oldest first, in pages.
async function* inboundTexts(db: StopSweepDb): AsyncGenerator<InboundSmsRow> {
  let after: string | undefined
  for (;;) {
    const rows = await db.message.findMany({
      where: { channel: 'sms', direction: 'incoming', ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, organizationId: true, smsRemotePhone: true, fromAddress: true, bodyText: true, dateCreated: true },
      orderBy: { id: 'asc' },
      take: PAGE,
    })
    yield* rows
    if (rows.length < PAGE) return
    after = rows[rows.length - 1].id
  }
}

export async function planStopSweep(db: StopSweepDb): Promise<StopSweepPlan> {
  const plan: StopSweepPlan = { inboundTexts: 0, optOutTexts: 0, optOutNumbers: 0, alreadyOnList: 0, missing: [], unreadableSender: [] }
  // Per org: number → its earliest opt-out text.
  const byOrg = new Map<string, Map<string, { row: InboundSmsRow; match: OptOutMatch }>>()
  for await (const row of inboundTexts(db)) {
    plan.inboundTexts++
    const match = classifyOptOut(row.bodyText)
    if (!match) continue
    plan.optOutTexts++
    const phone = toE164(row.smsRemotePhone ?? row.fromAddress)
    if (!phone) {
      plan.unreadableSender.push(row.id)
      continue
    }
    const numbers = byOrg.get(row.organizationId) ?? new Map()
    byOrg.set(row.organizationId, numbers)
    const seen = numbers.get(phone)
    if (!seen || row.dateCreated < seen.row.dateCreated) numbers.set(phone, { row, match })
  }
  for (const [orgId, numbers] of byOrg) {
    plan.optOutNumbers += numbers.size
    const listed = await internalDncHits(orgId, [...numbers.keys()], db)
    for (const [phone, { row, match }] of numbers) {
      if (listed.has(normalizeE164(phone))) plan.alreadyOnList++
      else plan.missing.push({ messageId: row.id, organizationId: orgId, phone, match })
    }
  }
  return plan
}

// Adds the missing opt-outs. addInternalDnc is idempotent, so a number added
// meanwhile (a new STOP, a redelivery) is reported as already there.
export async function applyStopSweep(
  db: StopSweepDb,
  plan: StopSweepPlan,
): Promise<{ added: number; alreadyThere: number }> {
  let added = 0
  let alreadyThere = 0
  for (const item of plan.missing) {
    const r = await addInternalDnc(
      item.organizationId,
      { phone: item.phone, reason: STOP_REASON[item.match.kind], addedBy: 'brief41-1-stop-sweep' },
      db,
    )
    if (r.added) added++
    else alreadyThere++
  }
  return { added, alreadyThere }
}

// What the script prints: counts and message ids, never a phone number.
export function describeStopSweep(plan: StopSweepPlan) {
  return {
    inboundTexts: plan.inboundTexts,
    optOutTexts: plan.optOutTexts,
    optOutNumbers: plan.optOutNumbers,
    alreadyOnList: plan.alreadyOnList,
    missingOptOuts: plan.missing.length,
    missing: plan.missing.map((m) => ({ messageId: m.messageId, match: m.match.kind, phrase: m.match.phrase })),
    unreadableSender: plan.unreadableSender,
  }
}
