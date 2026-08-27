import { resolveDb } from '@/lib/compliance/db'
import { internalDncHits } from '@/lib/compliance/dnc/internal'
import { isPolicyConfirmed } from '@/lib/compliance/policy/gate'
import { checkHoliday, holidayTableFreshDays } from '@/lib/compliance/holidays/check'
import { checkDncBatch } from '@/lib/compliance/dnc/check'
import { checkLitigatorBatch } from '@/lib/compliance/litigator/check'
import { writeScrubLogs } from '@/lib/compliance/scrub/scrubLog'
import { emitScrubCompleted } from '@/lib/compliance/events/emitScrubCompleted'
import type { CallableNowDeps, LoadedPhone } from '@/lib/compliance/scrub/callableNow'

// Wires the callable-now pipeline to real Prisma. Kept OUT of callableNow.ts so
// the decision logic stays free of DB imports and fully unit-testable. The
// `prisma` param is injectable, so this factory is itself testable with a fake
// client that records the queries it receives.

// Derive the contact's address state per §1a: addresses[0].state, but only when
// Lead.primaryAddressFull is set (otherwise the address is not trustworthy).
function deriveAddressState(lead: { addresses?: unknown; primaryAddressFull?: string | null } | null): string | null {
  if (!lead || !lead.primaryAddressFull) return null
  const addrs = lead.addresses
  if (Array.isArray(addrs) && addrs.length > 0 && addrs[0] && typeof addrs[0] === 'object') {
    const st = (addrs[0] as Record<string, unknown>).state
    return typeof st === 'string' ? st : null
  }
  return null
}

export function makeCallableNowDeps(args: {
  orgId: string
  correlationId: string
  now: Date
  prisma?: any
}): CallableNowDeps {
  const db = resolveDb<any>(args.prisma)

  return {
    orgId: args.orgId,
    correlationId: args.correlationId,
    now: args.now,

    async loadContactPhones(ids: string[]): Promise<Map<string, LoadedPhone>> {
      const rows = await db.contactPhone.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          phone: true,
          contact: {
            select: {
              timezone: true,
              lead: { select: { addresses: true, primaryAddressFull: true } },
            },
          },
        },
      })
      const map = new Map<string, LoadedPhone>()
      for (const r of rows) {
        map.set(r.id, {
          phone: r.phone,
          timezone: r.contact?.timezone ?? null,
          addressState: deriveAddressState(r.contact?.lead ?? null),
        })
      }
      return map
    },

    internalDncHits: (orgId, phones) => internalDncHits(orgId, phones, db),

    isPolicyConfirmed: (orgId, tz) => isPolicyConfirmed(orgId, tz, { db, useCache: true }),

    holidayFreshDays: () => holidayTableFreshDays(args.orgId, db),

    checkHoliday: (a) => checkHoliday(a, { db, freshDays: a.freshDays, useCache: true }),

    // Vendor read-through checks. With no vendor configured, these fail-closed
    // (noop vendor → vendor_error_not_configured) — a call is never greenlit
    // without DNC scrubbing.
    checkDnc: (orgId, phones) => checkDncBatch(orgId, phones, { db, correlationId: args.correlationId }),
    checkLitigator: (orgId, phones) => checkLitigatorBatch(orgId, phones, { db, correlationId: args.correlationId }),

    async persist(orgId, logs, event) {
      // ScrubLog writes + the crm_scrub NOTIFY commit atomically: a rolled-back
      // scrub never notifies a listener of an uncommitted decision.
      await db.$transaction(async (tx: any) => {
        await writeScrubLogs(orgId, logs, tx)
        await emitScrubCompleted(event, tx)
      })
    },
  }
}
