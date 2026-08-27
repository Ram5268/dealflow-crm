import type { PrismaClient } from "@prisma/client";
import { isHalted } from "../pacing/haltState";
import { logger } from "@/lib/logger";

export interface CreateDialSessionBody {
  viewId: string;
  method: "power" | "predictive";
  lineCount: number;
  maxLineCount?: number;
  callerId: string;
}

export interface CreateDialSessionContext {
  organizationId: string;
  userId: string;
}

export type CreateDialSessionResult =
  | { ok: true; sessionId: string; startedAt: string }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Create a dial session, enforcing the safety gates BEFORE any insert:
 *
 *  1. **Predictive loser-TwiML gate** (§13 L1 / FCC abandoned-call belt+suspenders):
 *     `method=predictive` requires `LOSER_TWIML_APPROVED === 'true'`. Predictive
 *     is multi-line → there can be a dropped-loser, so its message MUST be
 *     approved. Power/single-line is always safe (no loser). Refuse with
 *     `loser_twiml_unapproved`.
 *  2. **Circuit breaker**: if globally halted → 503 pacing_halted.
 *  (Spend-cap 503 is wired in Milestone 5; queue viewId verification in M4.)
 */
export async function createDialSession(
  prisma: PrismaClient,
  body: CreateDialSessionBody,
  ctx: CreateDialSessionContext,
): Promise<CreateDialSessionResult> {
  if (body.method === "predictive" && process.env.LOSER_TWIML_APPROVED !== "true") {
    logger.warn(
      { viewId: body.viewId },
      "Refusing predictive dial session — LOSER_TWIML_APPROVED not set",
    );
    return { ok: false, status: 403, body: { error: "loser_twiml_unapproved" } };
  }

  const halt = await isHalted(prisma);
  if (halt.halted) {
    return {
      ok: false,
      status: 503,
      body: { error: halt.reason === "spend" ? "spend_cap_reached" : "pacing_halted" },
    };
  }

  const ringTimeoutSec = parseInt(process.env.RING_TIMEOUT_SECONDS ?? "19", 10);
  const session = await prisma.dialSession.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      sourceType: "saved-search",
      sourceValue: body.viewId,
      method: body.method,
      lineCount: body.lineCount,
      maxLineCount: body.maxLineCount ?? 3,
      callerId: body.callerId,
      ringTimeoutSec,
    },
  });

  return { ok: true, sessionId: session.id, startedAt: session.startedAt.toISOString() };
}
