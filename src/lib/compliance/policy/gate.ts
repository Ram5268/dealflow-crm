import { resolveDb } from '@/lib/compliance/db'
import { policyGateCache, policyCacheKey } from '@/lib/compliance/caches'

// THE policy-confirmation gate — the second-most-load-bearing rule in the slice
// after fail-closed itself. A tenant may NOT dial any number in a timezone
// until Ryan has confirmed a CallingWindowConfig for that timezone (after
// conferring with counsel). Until then, every callable check returns
// `policy_unconfirmed`. This is never bypassed in tests or dev.

export interface CallingWindowConfigRow {
  timezone: string
  earliestHour: number
  latestHour: number
  allowedDaysOfWeek: number[]
  policyConfirmedBy: string | null
  policyConfirmedAt: Date | null
}

export interface PolicyGateResult {
  confirmed: boolean
  config?: CallingWindowConfigRow
}

// PURE classifier. No row => unconfirmed. Row present but policyConfirmedBy is
// null => unconfirmed. Only a row with a non-empty policyConfirmedBy is
// confirmed.
export function classifyPolicy(config: CallingWindowConfigRow | null | undefined): PolicyGateResult {
  if (!config) return { confirmed: false }
  if (!config.policyConfirmedBy) return { confirmed: false }
  return { confirmed: true, config }
}

export interface PolicyGateDb {
  callingWindowConfig: {
    findUnique: (args: any) => Promise<CallingWindowConfigRow | null>
  }
}

export async function isPolicyConfirmed(
  orgId: string,
  timezone: string,
  opts: { db?: PolicyGateDb; useCache?: boolean } = {}
): Promise<PolicyGateResult> {
  const key = policyCacheKey(orgId, timezone)
  if (opts.useCache) {
    const hit = policyGateCache.get(key)
    if (hit) return hit as PolicyGateResult
  }
  const db = resolveDb<PolicyGateDb>(opts.db)
  const config = await db.callingWindowConfig.findUnique({
    where: { organizationId_timezone: { organizationId: orgId, timezone } },
  })
  const result = classifyPolicy(config)
  if (opts.useCache) policyGateCache.set(key, result)
  return result
}
