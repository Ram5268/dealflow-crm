import { prisma as defaultPrisma } from '@/lib/compliance/db'
import type { CallingWindowConfigRow } from '@/lib/compliance/policy/gate'

// Aggregates the policy picture Ryan sees in Settings: every configured window
// plus the timezones that still need a confirmed policy before their contacts
// can be dialed. A timezone is "unconfirmed" if it appears on any Contact but
// has no CallingWindowConfig row OR a row with null policyConfirmedBy.

export interface PolicyStatus {
  configs: Array<{
    timezone: string
    earliestHour: number
    latestHour: number
    allowedDaysOfWeek: number[]
    policyConfirmedBy: string | null
    policyConfirmedAt: string | null
  }>
  unconfirmedTimezones: string[]
}

export interface PolicyStatusDb {
  callingWindowConfig: { findMany: (args: any) => Promise<CallingWindowConfigRow[]> }
  contact: { findMany: (args: any) => Promise<Array<{ timezone: string | null }>> }
}

export async function getPolicyStatus(
  orgId: string,
  db: PolicyStatusDb = defaultPrisma as unknown as PolicyStatusDb
): Promise<PolicyStatus> {
  const configs = await db.callingWindowConfig.findMany({
    where: { organizationId: orgId },
    select: {
      timezone: true,
      earliestHour: true,
      latestHour: true,
      allowedDaysOfWeek: true,
      policyConfirmedBy: true,
      policyConfirmedAt: true,
    },
  })

  const contactTz = await db.contact.findMany({
    where: { organizationId: orgId, timezone: { not: null } },
    distinct: ['timezone'],
    select: { timezone: true },
  })

  const confirmed = new Set(configs.filter((c) => c.policyConfirmedBy).map((c) => c.timezone))
  const unconfirmedTimezones = contactTz
    .map((r) => r.timezone)
    .filter((tz): tz is string => tz != null && !confirmed.has(tz))

  return {
    configs: configs.map((c) => ({
      timezone: c.timezone,
      earliestHour: c.earliestHour,
      latestHour: c.latestHour,
      allowedDaysOfWeek: c.allowedDaysOfWeek,
      policyConfirmedBy: c.policyConfirmedBy,
      policyConfirmedAt: c.policyConfirmedAt ? c.policyConfirmedAt.toISOString() : null,
    })),
    unconfirmedTimezones,
  }
}
