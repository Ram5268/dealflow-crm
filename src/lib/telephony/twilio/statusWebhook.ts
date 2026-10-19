import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mapTwilioStatus, isTerminalLocalStatus, type LocalCallStatus } from "./statusMap";
import { emitOnCallChannel } from "../events/emit";
import { recordCallCompleted } from "@/lib/core-data/activity/write";
import { logger } from "@/lib/logger";

/** Twilio status-callback params we consume. */
export interface StatusWebhookParams {
  CallSid: string;
  CallStatus: string;
  CallDuration?: string;
  Price?: string;
  [k: string]: string | undefined;
}

/** call.completed disposition vocabulary (frozen event enum §7.1). */
export type EventDisposition =
  | "answered"
  | "vm-answer"
  | "vm-left"
  | "busy"
  | "blocked"
  | "error"
  | "abandoned"
  | "no-answer";

const VALID_EVENT_DISPOSITIONS: ReadonlySet<string> = new Set([
  "answered", "vm-answer", "vm-left", "busy", "blocked", "error", "abandoned", "no-answer",
]);

/**
 * Resolve the call.completed disposition. Prefer a disposition already written
 * by the AMD/race path (answered | vm-answer | abandoned); otherwise derive from
 * the terminal status.
 *
 * The event enum carries an explicit `no-answer` (§13 S4, planner-blessed) — a
 * Twilio `no-answer` terminal maps to `no-answer`, not `error`, so TCPA
 * post-analysis and the ammunition ranker see the truth. `failed`/`cancel`/
 * `timeout` remain `error`.
 */
export function toEventDisposition(
  local: LocalCallStatus,
  existing: string | null | undefined,
): EventDisposition {
  if (existing && VALID_EVENT_DISPOSITIONS.has(existing)) {
    return existing as EventDisposition;
  }
  switch (local) {
    case "completed":
      return "answered";
    case "busy":
      return "busy";
    case "no-answer":
      return "no-answer";
    case "failed":
    case "cancel":
    case "timeout":
      return "error";
    default:
      return "error";
  }
}

export interface StatusWebhookResult {
  handled: boolean;
  emitted: boolean;
  localStatus: LocalCallStatus | null;
}

/**
 * Handle a Twilio status callback. Idempotent on CallSid: the `call.completed`
 * emission is guarded by `Call.emittedAt` (set in the same tx as the emit), so
 * replays never double-emit. Unknown status → no-op (logged). Unknown CallSid →
 * no-op (the reconciliation job owns orphan convergence).
 *
 * Brief 50 (PR 3): the lead's timeline entry (Activity) for the finished call
 * is written in the same tx, so it commits with the final status. Nothing on
 * Vercel consumes `call.completed`, so without this no call ever reached the
 * timeline.
 */
export async function handleStatusWebhook(
  prisma: PrismaClient,
  params: StatusWebhookParams,
): Promise<StatusWebhookResult> {
  const local = mapTwilioStatus(params.CallStatus);
  if (local === null) {
    return { handled: false, emitted: false, localStatus: null };
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ id: string; disposition: string | null; emittedAt: Date | null; duration: number | null }>
    >`SELECT id, disposition, "emittedAt", duration FROM "Call" WHERE "providerCallSid" = ${params.CallSid} FOR UPDATE`;
    const call = rows[0];
    if (!call) {
      logger.warn({ callSid: params.CallSid }, "status webhook for unknown CallSid — recon will converge");
      return { handled: false, emitted: false, localStatus: local };
    }

    const terminal = isTerminalLocalStatus(local);
    const alreadyEmitted = call.emittedAt !== null;

    const duration =
      params.CallDuration !== undefined ? parseInt(params.CallDuration, 10) : call.duration;
    // Twilio Price is negative (a debit) in account currency — store magnitude.
    const cost =
      params.Price !== undefined && params.Price !== ""
        ? new Prisma.Decimal(params.Price).abs()
        : undefined;
    const disposition = terminal ? toEventDisposition(local, call.disposition) : call.disposition;

    const shouldEmit = terminal && !alreadyEmitted;

    await tx.call.update({
      where: { id: call.id },
      data: {
        status: local,
        ...(duration !== null && duration !== undefined ? { duration } : {}),
        ...(cost !== undefined ? { cost } : {}),
        ...(disposition ? { disposition } : {}),
        ...(shouldEmit ? { emittedAt: new Date() } : {}),
      },
    });

    if (shouldEmit) {
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
        cost: cost !== undefined ? cost.toString() : null, // decimal-as-string
        correlationId: randomUUID(),
      });
    }

    return { handled: true, emitted: shouldEmit, localStatus: local };
  });
}
