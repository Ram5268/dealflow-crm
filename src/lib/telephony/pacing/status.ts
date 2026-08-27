import type { PrismaClient } from "@prisma/client";
import { rollingAbandonment, rollingAmdFpRate } from "./metrics";
import { isHalted } from "./haltState";

export interface PacingStatus {
  currentLineCount: number | null;
  abandonment30dPct: number;
  amdFalsePositive24hPct: number;
  halted: boolean;
  haltReason?: "abandonment" | "spend";
}

/** Current pacing snapshot for /api/telephony/pacing/status (brief §8.1). */
export async function pacingStatus(
  prisma: PrismaClient,
  dialSessionId?: string,
): Promise<PacingStatus> {
  const [abandonment, amdFp, halt] = await Promise.all([
    rollingAbandonment(prisma),
    rollingAmdFpRate(prisma),
    isHalted(prisma),
  ]);
  let currentLineCount: number | null = null;
  if (dialSessionId) {
    const s = await prisma.dialSession.findUnique({
      where: { id: dialSessionId },
      select: { lineCount: true },
    });
    currentLineCount = s?.lineCount ?? null;
  }
  return {
    currentLineCount,
    abandonment30dPct: abandonment * 100,
    amdFalsePositive24hPct: amdFp * 100,
    halted: halt.halted,
    ...(halt.reason ? { haltReason: halt.reason } : {}),
  };
}
