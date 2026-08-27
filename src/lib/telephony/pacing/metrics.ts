import type { Prisma } from "@prisma/client";

/**
 * PacingMetric write helpers.
 *
 * Design: we APPEND a metric row per event rather than upserting a per-minute
 * counter. The pacing worker (Milestone 4) computes rolling ratios as
 * `sum(field) / sum(dialsInitiated)` across rows, so appending one row with a
 * single counter set is equivalent to incrementing — and avoids a non-atomic
 * read-modify-write against a table with no per-minute unique constraint.
 */

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
