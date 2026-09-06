import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * PacingMetric write helpers.
 *
 * Design: we APPEND a metric row per event rather than upserting a per-minute
 * counter. The pacing worker (Milestone 4) computes rolling ratios as
 * `sum(field) / sum(dialsInitiated)` across rows, so appending one row with a
 * single counter set is equivalent to incrementing — and avoids a non-atomic
 * read-modify-write against a table with no per-minute unique constraint.
 */

/**
 * Synthetic org for global circuit-breaker sentinel rows (halt/resume). These
 * are NOT dialing activity and MUST be excluded from rolling rate calculations
 * — the sentinel encodes the halt reason in amdFalsePositive, which would
 * otherwise pollute the abandonment/AMD-FP numerators.
 */
export const SYSTEM_ORG = "system";

export interface PacingCounters {
  dialsInitiated?: number;
  humansReached?: number;
  amdMachineHang?: number;
  abandonedCalls?: number;
  amdFalsePositive?: number;
}

/** Truncate a Date to the start of its UTC minute. */
export function minuteBucketUtc(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

/**
 * Append a PacingMetric row carrying one or more event counters. MUST run inside
 * the same tx as the state change it accounts for, so the metric can never
 * diverge from reality (both roll back together).
 */
export async function recordPacingEvent(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    dialSessionId?: string | null;
    counters: PacingCounters;
    currentLineCount?: number | null;
    now?: Date;
  },
): Promise<void> {
  const { organizationId, dialSessionId, counters, currentLineCount, now } = args;
  await tx.pacingMetric.create({
    data: {
      organizationId,
      dialSessionId: dialSessionId ?? null,
      minuteBucket: minuteBucketUtc(now ?? new Date()),
      dialsInitiated: counters.dialsInitiated ?? 0,
      humansReached: counters.humansReached ?? 0,
      amdMachineHang: counters.amdMachineHang ?? 0,
      abandonedCalls: counters.abandonedCalls ?? 0,
      amdFalsePositive: counters.amdFalsePositive ?? 0,
      currentLineCount: currentLineCount ?? null,
    },
  });
}

/**
 * Rolling 30-day abandonment fraction:
 *   (sum(abandonedCalls) + sum(amdFalsePositive)) / sum(dialsInitiated)
 * The AMD-FP term is DELIBERATELY double-counted per FTC 16 CFR 310.4(b)(4)
 * (see docs/pacing-control-law.md). Zero denominator → 0.
 */
export async function rollingAbandonment(prisma: PrismaClient, windowDays = 30): Promise<number> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const agg = await prisma.pacingMetric.aggregate({
    where: { minuteBucket: { gte: since }, organizationId: { not: SYSTEM_ORG } },
    _sum: { abandonedCalls: true, amdFalsePositive: true, dialsInitiated: true },
  });
  const dials = agg._sum.dialsInitiated ?? 0;
  if (dials === 0) return 0;
  return ((agg._sum.abandonedCalls ?? 0) + (agg._sum.amdFalsePositive ?? 0)) / dials;
}

/** Rolling 24h AMD-false-positive rate: sum(amdFalsePositive)/sum(dialsInitiated). */
export async function rollingAmdFpRate(prisma: PrismaClient, windowHours = 24): Promise<number> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const agg = await prisma.pacingMetric.aggregate({
    where: { minuteBucket: { gte: since }, organizationId: { not: SYSTEM_ORG } },
    _sum: { amdFalsePositive: true, dialsInitiated: true },
  });
  const dials = agg._sum.dialsInitiated ?? 0;
  if (dials === 0) return 0;
  return (agg._sum.amdFalsePositive ?? 0) / dials;
}

/**
 * Month-to-date Twilio spend (USD) = sum(Call.cost) since UTC month start.
 *
 * SYSTEM_ORG is excluded for the same reason `rollingAmdFpRate` excludes it:
 * those rows are not real dialing activity. This feeds `monthlyCapStatus` and
 * the pacing worker's spend-halt input, so sentinel or seeded rows counted here
 * inflate spend against a cap Ryan never actually spent — and can trip the
 * global breaker. The halt decision stays deliberately global (see
 * `runPacingTick`), so this filters the synthetic org only, not by caller org.
 */
export async function monthToDateSpendUsd(prisma: PrismaClient, now = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await prisma.call.aggregate({
    where: { activityAt: { gte: monthStart }, organizationId: { not: SYSTEM_ORG } },
    _sum: { cost: true },
  });
  return agg._sum.cost ? Number(agg._sum.cost) : 0;
}
