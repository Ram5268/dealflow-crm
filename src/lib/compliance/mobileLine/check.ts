import { resolveDb } from '@/lib/compliance/db'
import { twilioLineLookup, type LineTypeResult } from '@/lib/compliance/mobileLine/twilioLookup'

// Mobile-line identification — ADVISORY ONLY (§2e MVP decision). A Twilio Lookup
// error NEVER flips callable; it only writes a ScrubLog check-mobile-line row.
// 90-day cache. On stale-cache + live error, serve the stale row (advisory
// clean). On no-row + live error, return an advisory error (still not blocking).

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export interface MobileLineResult {
  lineType: string | null
  carrier?: string
  stale: boolean
  error: boolean
}

export interface MobileLineDb {
  mobileLineCache: {
    findUnique: (args: any) => Promise<{ lineType: string; carrier: string | null; expiresAt: Date } | null>
    upsert: (args: any) => Promise<unknown>
  }
  scrubLog: { create: (args: any) => Promise<unknown> }
}

export interface MobileLineDeps {
  db?: MobileLineDb
  now?: Date
  lookup?: (phone: string) => Promise<LineTypeResult>
  correlationId?: string
}

export async function checkMobileLine(
  orgId: string,
  phone: string,
  deps: MobileLineDeps = {}
): Promise<MobileLineResult> {
  const db = resolveDb<MobileLineDb>(deps.db)
  const now = deps.now ?? new Date()
  const lookup = deps.lookup ?? ((p: string) => twilioLineLookup(p))
  const correlationId = deps.correlationId ?? 'mobile-line'

  const log = (result: 'clean' | 'error', detail: Record<string, unknown>) =>
    db.scrubLog.create({
      data: { organizationId: orgId, phone, operation: 'check-mobile-line', result, detail: { ...detail, correlationId } },
    })

  const row = await db.mobileLineCache.findUnique({ where: { organizationId_phone: { organizationId: orgId, phone } } })

  if (row && row.expiresAt.getTime() > now.getTime()) {
    await log('clean', { cached: true, lineType: row.lineType })
    return { lineType: row.lineType, carrier: row.carrier ?? undefined, stale: false, error: false }
  }

  try {
    const live = await lookup(phone)
    await db.mobileLineCache.upsert({
      where: { organizationId_phone: { organizationId: orgId, phone } },
      update: { lineType: live.lineType, carrier: live.carrier ?? null, checkedAt: now, expiresAt: new Date(now.getTime() + NINETY_DAYS_MS) },
      create: { organizationId: orgId, phone, lineType: live.lineType, carrier: live.carrier ?? null, expiresAt: new Date(now.getTime() + NINETY_DAYS_MS) },
    })
    await log('clean', { lineType: live.lineType })
    return { lineType: live.lineType, carrier: live.carrier, stale: false, error: false }
  } catch (err) {
    // Advisory: never fail-closed. Serve a stale row if we have one.
    if (row) {
      await log('clean', { stale: true, error: String(err) })
      return { lineType: row.lineType, carrier: row.carrier ?? undefined, stale: true, error: false }
    }
    await log('error', { error: String(err) })
    return { lineType: null, stale: false, error: true }
  }
}
