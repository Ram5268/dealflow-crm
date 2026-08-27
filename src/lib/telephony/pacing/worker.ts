import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { computeNewLineCount, abandonmentBand } from "./computeNewLineCount";
import {
  recordPacingEvent,
  rollingAbandonment,
  rollingAmdFpRate,
  monthToDateSpendUsd,
} from "./metrics";
import { setHalt } from "./haltState";
import { emitOnCallChannel } from "../events/emit";
import { logger } from "@/lib/logger";

export interface PacingTickResult {
  abandonment: number;
  amdFpRate: number;
  spendUsd: number;
  halted: boolean;
  haltReason?: "abandonment" | "spend";
  sessionsUpdated: number;
}

/**
 * One pacing-worker tick (invoked every PACING_INTERVAL_SECONDS, default 60):
 *  - compute rolling 30d abandonment (with the deliberate AMD-FP double-count),
 *    24h AMD-FP rate, and month-to-date spend;
 *  - evaluate the control law globally for the halt decision;
 *  - if halted → trip the breaker + pause every active session (lineCount 0);
 *  - else adjust each active session's lineCount via computeNewLineCount;
 *  - snapshot a PacingMetric row and emit `dial-session.pacing-update` per
 *    session (frozen contract shape: `type` discriminant + abandonment30d).
 */
export async function runPacingTick(prisma: PrismaClient): Promise<PacingTickResult> {
  const abandonment = await rollingAbandonment(prisma);
  const amdFpRate = await rollingAmdFpRate(prisma);
  const spendUsd = await monthToDateSpendUsd(prisma);
  const capUsd = parseInt(process.env.TWILIO_MONTHLY_SPEND_CAP_USD ?? "200", 10);
  const band = abandonmentBand(abandonment);

  const sessions = await prisma.dialSession.findMany({ where: { status: "active" } });

  // Global halt decision (line-count args irrelevant to the halt bands).
  const globalDecision = computeNewLineCount({
    currentLineCount: 1,
    maxLineCount: 1,
    thirtyDayAbandonment: abandonment,
    amdFalsePositiveRate24h: amdFpRate,
    monthlySpendUsd: spendUsd,
    monthlySpendCapUsd: capUsd,
  });

  if (globalDecision.action === "halt") {
    const haltReason = globalDecision.halt!.reason;
    await setHalt(prisma, haltReason);
    await prisma.dialSession.updateMany({
      where: { status: "active" },
      data: { status: "paused", lineCount: 0 },
    });
    for (const s of sessions) {
      await emitPacingUpdate(prisma, {
        sessionId: s.id,
        lineCount: 0,
        rollingAbandonment: abandonment,
        band,
        reason: `halt:${haltReason}`,
      });
    }
    logger.error({ haltReason, abandonment, spendUsd }, "PACING HALT — circuit breaker tripped");
    return {
      abandonment,
      amdFpRate,
      spendUsd,
      halted: true,
      haltReason,
      sessionsUpdated: sessions.length,
    };
  }

  for (const s of sessions) {
    const decision = computeNewLineCount({
      currentLineCount: s.lineCount,
      maxLineCount: s.maxLineCount,
      thirtyDayAbandonment: abandonment,
      amdFalsePositiveRate24h: amdFpRate,
      monthlySpendUsd: spendUsd,
      monthlySpendCapUsd: capUsd,
    });
    await prisma.$transaction(async (tx) => {
      await tx.dialSession.update({
        where: { id: s.id },
        data: { lineCount: decision.newLineCount },
      });
      await recordPacingEvent(tx, {
        organizationId: s.organizationId,
        dialSessionId: s.id,
        counters: {},
        currentLineCount: decision.newLineCount,
      });
      await emitOnCallChannel(tx, {
        type: "dial-session.pacing-update",
        sessionId: s.id,
        lineCount: decision.newLineCount,
        rollingAbandonment: abandonment,
        band,
        reason: decision.action,
        correlationId: randomUUID(),
      });
    });
  }

  return { abandonment, amdFpRate, spendUsd, halted: false, sessionsUpdated: sessions.length };
}

async function emitPacingUpdate(
  prisma: PrismaClient,
  payload: {
    sessionId: string;
    lineCount: number;
    rollingAbandonment: number;
    band: ReturnType<typeof abandonmentBand>;
    reason: string;
  },
): Promise<void> {
  await prisma.$transaction((tx) =>
    emitOnCallChannel(tx, {
      type: "dial-session.pacing-update",
      ...payload,
      correlationId: randomUUID(),
    }),
  );
}
