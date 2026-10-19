import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mapTwilioStatus, isTerminalLocalStatus } from "../twilio/statusMap";
import { toEventDisposition } from "../twilio/statusWebhook";
import { emitOnCallChannel } from "../events/emit";
import { recordCallCompleted } from "@/lib/core-data/activity/write";
import { logger } from "@/lib/logger";

/** Minimal Twilio REST surface the recon job needs (injectable for tests). */
export interface TwilioCallInstance {
  status: string;
  duration?: string | number | null;
  price?: string | number | null;
}
export interface TwilioRestLike {
  fetchCall: (sid: string) => Promise<TwilioCallInstance>;
  listCalls: (opts: { startTimeAfter: Date }) => Promise<Array<{ sid: string }>>;
  cancelCall: (sid: string) => Promise<void>;
}

export interface ReconDeps {
  twilio: TwilioRestLike;
  now?: Date;
}

export interface ReconResult {
  converged: number;
  orphansCanceled: number;
  reEmitted: number;
  twilioDown: boolean;
}

function toDecimalAbs(price: string | number | null | undefined): Prisma.Decimal | undefined {
  if (price === null || price === undefined || price === "") return undefined;
  return new Prisma.Decimal(price).abs();
}

/**
 * Reconciliation tick (every 5 min). Eliminates the webhook-delivered-once-or-
 * never class of bug:
 *  A. Stuck-call converge — Call stuck in created/in-progress >6min → fetch
 *     Twilio truth, update, emit call.completed if terminal.
 *  B. Orphan Twilio calls — Twilio calls not in our DB → cancel.
 *  C. Lost-emission recovery — terminal Call with emittedAt IS NULL >2min →
 *     re-emit call.completed (idempotent via the emittedAt guard).
 *
 * Twilio-down: on REST failure, skip A + B for this tick but ALWAYS run C
 * (DB-only). The next scheduled tick is the retry.
 *
 * Brief 50 (PR 3): wherever A or C emits call.completed, the lead's timeline
 * entry (Activity) is written in the same tx, as in the status webhook.
 */
export async function runReconciliation(prisma: PrismaClient, deps: ReconDeps): Promise<ReconResult> {
  const now = deps.now ?? new Date();
  let converged = 0;
  let orphansCanceled = 0;
  let twilioDown = false;

  // ── Sub-job A — stuck-call converge ──────────────────────────────────────
  try {
    const stuck = await prisma.call.findMany({
      where: {
        status: { in: ["created", "in-progress"] },
        dateCreated: { lt: new Date(now.getTime() - 6 * 60 * 1000) },
      },
      select: { id: true, providerCallSid: true, disposition: true },
    });
    for (const call of stuck) {
      const instance = await deps.twilio.fetchCall(call.providerCallSid);
      const local = mapTwilioStatus(instance.status);
      if (!local) continue;
      const terminal = isTerminalLocalStatus(local);
      const duration =
        instance.duration !== null && instance.duration !== undefined
          ? parseInt(String(instance.duration), 10)
          : undefined;
      const cost = toDecimalAbs(instance.price);
      const disposition = terminal ? toEventDisposition(local, call.disposition) : call.disposition;
      await prisma.$transaction(async (tx) => {
        await tx.call.update({
          where: { id: call.id },
          data: {
            status: local,
            ...(duration !== undefined ? { duration } : {}),
            ...(cost !== undefined ? { cost } : {}),
            ...(disposition ? { disposition } : {}),
            ...(terminal ? { emittedAt: now } : {}),
          },
        });
        if (terminal) {
          await recordCallCompleted(tx, {
            callId: call.id,
            disposition: toEventDisposition(local, call.disposition),
            duration: duration ?? null,
            cost: cost !== undefined ? cost.toString() : null,
          });
          await emitOnCallChannel(tx, {
            type: "call.completed",
            callId: call.id,
            disposition: toEventDisposition(local, call.disposition),
            duration: duration ?? null,
            cost: cost !== undefined ? cost.toString() : null,
            correlationId: randomUUID(),
          });
          converged += 1;
        }
      });
    }

    // ── Sub-job B — orphan Twilio calls ────────────────────────────────────
    const recent = await deps.twilio.listCalls({ startTimeAfter: new Date(now.getTime() - 5 * 60 * 1000) });
    for (const { sid } of recent) {
      const known = await prisma.call.findUnique({ where: { providerCallSid: sid }, select: { id: true } });
      if (!known) {
        await deps.twilio.cancelCall(sid);
        orphansCanceled += 1;
        logger.warn({ sid }, "orphan Twilio call canceled (create succeeded, DB insert failed)");
      }
    }
  } catch (err) {
    twilioDown = true;
    logger.error({ err }, "Twilio REST unreachable during reconciliation — skipping sub-jobs A/B this tick");
  }

  // ── Sub-job C — lost-emission recovery (DB-only, always runs) ─────────────
  const reEmitted = await recoverLostEmissions(prisma, now);

  return { converged, orphansCanceled, reEmitted, twilioDown };
}

/** Re-fire call.completed for terminal calls that never emitted. Idempotent. */
export async function recoverLostEmissions(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const stranded = await prisma.call.findMany({
    where: {
      status: { in: ["completed", "no-answer", "busy", "failed", "cancel"] },
      emittedAt: null,
      dateCreated: { lt: new Date(now.getTime() - 2 * 60 * 1000) },
    },
    select: { id: true, disposition: true, duration: true, cost: true, status: true },
  });
  let count = 0;
  for (const call of stranded) {
    await prisma.$transaction(async (tx) => {
      // Guard against a concurrent emit: only proceed if still unemitted.
      const fresh = await tx.call.findUnique({ where: { id: call.id }, select: { emittedAt: true } });
      if (fresh?.emittedAt) return;
      await tx.call.update({ where: { id: call.id }, data: { emittedAt: now } });
      await recordCallCompleted(tx, {
        callId: call.id,
        disposition: (call.disposition ?? "error") as string,
        duration: call.duration ?? null,
        cost: call.cost !== null ? call.cost.toString() : null,
      });
      await emitOnCallChannel(tx, {
        type: "call.completed",
        callId: call.id,
        disposition: (call.disposition ?? "error") as string,
        duration: call.duration ?? null,
        cost: call.cost !== null ? call.cost.toString() : null,
        correlationId: randomUUID(),
      });
      count += 1;
    });
  }
  return count;
}
