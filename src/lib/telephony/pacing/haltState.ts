import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Global circuit-breaker halt flag, stored as a sentinel PacingMetric row
 * (`dialSessionId = null`). Convention (documented; §13 request pending for a
 * dedicated SystemState table):
 *   currentLineCount = -1  → HALTED
 *   currentLineCount =  0  → explicitly un-halted (resume)
 *   amdFalsePositive  =  1  → halt reason "abandonment"
 *   amdFalsePositive  =  2  → halt reason "spend"
 * The LATEST sentinel row (by minuteBucket) wins.
 *
 * Milestone 2 uses only the read path (isHalted) for /health. The write path
 * (setHalt / clearHalt) is wired by the pacing worker in Milestone 4.
 */
export type HaltReason = "abandonment" | "spend";

export interface HaltState {
  halted: boolean;
  reason?: HaltReason;
}

export async function isHalted(prisma: PrismaClient = defaultPrisma): Promise<HaltState> {
  try {
    const rows = await prisma.pacingMetric.findMany({
      where: { dialSessionId: null, currentLineCount: { in: [-1, 0] } },
      orderBy: { minuteBucket: "desc" },
      take: 1,
    });
    const sentinel = rows[0];
    if (!sentinel || sentinel.currentLineCount !== -1) return { halted: false };
    const reason: HaltReason = sentinel.amdFalsePositive === 2 ? "spend" : "abandonment";
    return { halted: true, reason };
  } catch (err) {
    // Health must not throw. The authoritative dial guard reads the flag
    // separately and fail-closes; here we log and report unknown-as-not-halted.
    logger.warn({ err }, "isHalted read failed — reporting not-halted for health");
    return { halted: false };
  }
}
