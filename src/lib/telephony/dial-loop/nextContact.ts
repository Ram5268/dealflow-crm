import type { PrismaClient } from "@prisma/client";
import type { QueueLead } from "./schemas";
import { logger } from "@/lib/logger";

/**
 * The 72-hour dropped-loser dial-exclusion — SINGLE OWNER = Agent B (§4.1).
 *
 * Agent A's queue does not know about this. B is the last line before dial: skip
 * any contactPhoneId whose most recent CallLeg (B's own table — a self-read) is
 * `dropped-loser` with `droppedLoserMessage=true` and `startedAt` within 72h.
 *
 * Also drops leads with no `primaryPhoneId` — without it we cannot run the
 * compliance check, so fail-closed (never dial an un-checkable phone).
 */
export async function eligibleLeads(
  prisma: PrismaClient,
  leads: QueueLead[],
): Promise<QueueLead[]> {
  const withPhoneId = leads.filter((l) => {
    if (!l.primaryPhoneId) {
      logger.warn({ leadId: l.leadId }, "queue lead missing primaryPhoneId — skipping (fail-closed)");
      return false;
    }
    return true;
  });
  if (withPhoneId.length === 0) return [];

  const ids = withPhoneId.map((l) => l.primaryPhoneId as string);
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
  const recentLosers = await prisma.callLeg.findMany({
    where: {
      contactPhoneId: { in: ids },
      disposition: "dropped-loser",
      droppedLoserMessage: true,
      startedAt: { gte: cutoff },
    },
    select: { contactPhoneId: true },
    distinct: ["contactPhoneId"],
  });
  const excluded = new Set(recentLosers.map((r) => r.contactPhoneId));
  if (excluded.size > 0) {
    logger.info({ excludedCount: excluded.size }, "excluding recent dropped-loser contacts (72h)");
  }
  return withPhoneId.filter((l) => !excluded.has(l.primaryPhoneId as string));
}
