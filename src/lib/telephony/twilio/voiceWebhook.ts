import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { parseAmd } from "./amd";
import { buildConferenceTwiml, buildHangupTwiml } from "./twiml";
import { buildLoserTwiml } from "../race-resolver/droppedLoser";
import { tryAcquireCallWinner } from "../race-resolver/acquireWinner";
import { emitOnCallChannel } from "../events/emit";
import { recordPacingEvent } from "../pacing/metrics";
import { logger } from "@/lib/logger";

export interface AmdWebhookParams {
  CallSid: string; // the leg's Twilio SID (== CallLeg.providerLegSid)
  AnsweredBy?: string;
  [k: string]: string | undefined;
}

export interface AmdWebhookResult {
  twiml: string;
  outcome: "bridged-winner" | "dropped-loser" | "voicemail" | "replay" | "unknown-leg";
  emittedConnected: boolean;
}

/**
 * Derive the TwiML that a prior decision would have produced — used on idempotent
 * replay so the same webhook returns the same TwiML without re-emitting.
 */
function twimlForExistingDisposition(disposition: string | null, callId: string): string {
  switch (disposition) {
    case "won":
      return buildConferenceTwiml(callId);
    case "dropped-loser":
      return buildLoserTwiml();
    case "vm-answer":
      return buildHangupTwiml();
    default:
      return buildHangupTwiml();
  }
}

/**
 * Handle the async-AMD voice webhook (Twilio's second POST, carrying AnsweredBy).
 *
 * Idempotent on (CallSid == providerLegSid): the leg row is locked FOR UPDATE;
 * if `amdResult` is already set we return the prior decision's TwiML and neither
 * re-write nor re-emit. `human`/`unknown` contend for the per-Call advisory lock
 * — winner bridges into the conference and emits `call.connected`; loser is
 * marked `dropped-loser` and counted as an abandoned call. `machine`/`fax` hang
 * up as voicemail.
 */
export async function handleAmdWebhook(
  prisma: PrismaClient,
  params: AmdWebhookParams,
  correlationId: string = randomUUID(),
): Promise<AmdWebhookResult> {
  const parsed = parseAmd(params.AnsweredBy);

  return prisma.$transaction(async (tx) => {
    const legRows = await tx.$queryRaw<
      Array<{ id: string; callId: string; amdResult: string | null; disposition: string | null }>
    >`SELECT id, "callId", "amdResult", disposition FROM "CallLeg" WHERE "providerLegSid" = ${params.CallSid} FOR UPDATE`;
    const leg = legRows[0];
    if (!leg) {
      logger.warn({ callSid: params.CallSid }, "AMD webhook for unknown leg SID");
      return { twiml: buildHangupTwiml(), outcome: "unknown-leg", emittedConnected: false };
    }

    // ── Idempotent replay ────────────────────────────────────────────────
    if (leg.amdResult !== null) {
      if (leg.amdResult !== parsed.amdResult) {
        logger.warn(
          { callSid: params.CallSid, was: leg.amdResult, now: parsed.amdResult },
          "AMD changed its mind on replay — honoring the original decision",
        );
      }
      return {
        twiml: twimlForExistingDisposition(leg.disposition, leg.callId),
        outcome: "replay",
        emittedConnected: false,
      };
    }

    const call = await tx.call.findUnique({ where: { id: leg.callId } });
    if (!call) {
      logger.error({ legId: leg.id, callId: leg.callId }, "leg references missing Call");
      return { twiml: buildHangupTwiml(), outcome: "unknown-leg", emittedConnected: false };
    }

    // ── Machine / fax → voicemail hangup ─────────────────────────────────
    if (!parsed.bridge) {
      await tx.callLeg.update({
        where: { id: leg.id },
        data: { amdResult: parsed.amdResult, disposition: parsed.vmDisposition },
      });
      await tx.call.update({ where: { id: call.id }, data: { disposition: "vm-answer" } });
      await recordPacingEvent(tx, {
        organizationId: call.organizationId,
        dialSessionId: call.dialSessionId,
        counters: { amdMachineHang: 1 },
      });
      return { twiml: buildHangupTwiml(), outcome: "voicemail", emittedConnected: false };
    }

    // ── Human / unknown → contend for the winner lock ────────────────────
    // The advisory lock serializes CONCURRENT AMD callbacks. The persistent
    // "prior winner" check additionally rejects a leg that arrives AFTER another
    // leg already won and committed (the lock is per-tx, so it would otherwise be
    // re-acquirable). Both together = correct under concurrency AND sequencing.
    const acquired = await tryAcquireCallWinner(tx, leg.callId);
    const priorWinner = acquired
      ? await tx.callLeg.findFirst({ where: { callId: leg.callId, disposition: "won" } })
      : null;
    const won = acquired && !priorWinner;
    if (won) {
      const connectedAt = new Date();
      await tx.callLeg.update({
        where: { id: leg.id },
        data: { amdResult: parsed.amdResult, disposition: "won", connectedAt },
      });
      await tx.call.update({
        where: { id: call.id },
        data: { disposition: "answered", status: "in-progress" },
      });
      await recordPacingEvent(tx, {
        organizationId: call.organizationId,
        dialSessionId: call.dialSessionId,
        counters: { humansReached: 1 },
      });
      await emitOnCallChannel(tx, {
        type: "call.connected",
        callId: call.id,
        dialSessionId: call.dialSessionId ?? "",
        leadId: call.leadId ?? null,
        contactId: call.contactId ?? null,
        remotePhone: call.remotePhone,
        connectedAt: connectedAt.toISOString(),
        correlationId,
      });
      return { twiml: buildConferenceTwiml(call.id), outcome: "bridged-winner", emittedConnected: true };
    }

    // Loser: mark dropped, count as abandoned, play the loser message.
    await tx.callLeg.update({
      where: { id: leg.id },
      data: { amdResult: parsed.amdResult, disposition: "dropped-loser", droppedLoserMessage: true },
    });
    await recordPacingEvent(tx, {
      organizationId: call.organizationId,
      dialSessionId: call.dialSessionId,
      counters: { abandonedCalls: 1 },
    });
    return { twiml: buildLoserTwiml(), outcome: "dropped-loser", emittedConnected: false };
  });
}
