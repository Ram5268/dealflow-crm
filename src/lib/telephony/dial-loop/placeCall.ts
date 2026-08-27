import type { PrismaClient } from "@prisma/client";
import { twilioClient } from "../twilio/client";
import { recordPacingEvent } from "../pacing/metrics";
import { logger } from "@/lib/logger";

/** Minimal shape of the Twilio calls.create API we depend on (for injection). */
export interface TwilioCallCreator {
  calls: {
    create: (opts: Record<string, unknown>) => Promise<{ sid: string }>;
  };
}

export interface PlaceCallArgs {
  organizationId: string;
  userId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  dialSessionId?: string | null;
  callMethod: "regular" | "power" | "predictive";
  callerId: string; // E.164 (Call.localPhone / from)
  toPhone: string; // E.164 (Call.remotePhone / to)
  contactPhoneId: string;
  ringTimeoutSec?: number;
}

export interface PlaceCallDeps {
  client?: TwilioCallCreator;
  webhookBase?: string; // e.g. https://crm.dealflow.com/api/telephony/webhook
}

/**
 * Place an outbound call. Twilio FIRST (so we always have a real providerCallSid),
 * then insert Call + initial CallLeg in ONE transaction with a dialsInitiated
 * metric. `Call.source` is set to "dealflow-crm" explicitly, overriding the
 * frozen schema default of "Close.io" (§6.1 item 2 workaround).
 *
 * If Twilio succeeds but the DB insert fails, the row is an orphan Twilio call —
 * the reconciliation job (Milestone 5) cancels it within ~5 min. We log + rethrow.
 */
export async function placeCall(
  prisma: PrismaClient,
  args: PlaceCallArgs,
  deps: PlaceCallDeps = {},
): Promise<{ callId: string; providerCallSid: string }> {
  const client = deps.client ?? (twilioClient() as unknown as TwilioCallCreator);
  const webhookBase = deps.webhookBase ?? process.env.TWILIO_VOICE_WEBHOOK_BASE ?? "";
  const ringTimeoutSec =
    args.ringTimeoutSec ?? parseInt(process.env.RING_TIMEOUT_SECONDS ?? "19", 10);

  const voiceUrl = `${webhookBase}/voice`;
  const statusUrl = `${webhookBase}/status`;

  // ── Twilio first ─────────────────────────────────────────────────────────
  const created = await client.calls.create({
    to: args.toPhone,
    from: args.callerId,
    url: voiceUrl,
    method: "POST",
    statusCallback: statusUrl,
    statusCallbackMethod: "POST",
    machineDetection: "DetectMessageEnd",
    asyncAmd: "true",
    asyncAmdStatusCallback: voiceUrl,
    asyncAmdStatusCallbackMethod: "POST",
    timeout: ringTimeoutSec,
  });

  // ── DB insert (Call + initial leg + metric) in one tx ─────────────────────
  try {
    const callId = await prisma.$transaction(async (tx) => {
      const call = await tx.call.create({
        data: {
          organizationId: args.organizationId,
          userId: args.userId ?? null,
          leadId: args.leadId ?? null,
          contactId: args.contactId ?? null,
          dialSessionId: args.dialSessionId ?? null,
          direction: "outbound",
          callMethod: args.callMethod,
          status: "created",
          // source falls to the schema default "dealflow-crm" (§13 S2 migration).
          localPhone: args.callerId,
          remotePhone: args.toPhone,
          providerCallSid: created.sid,
          providerStatusCallback: statusUrl,
        },
      });
      await tx.callLeg.create({
        data: {
          callId: call.id,
          contactPhoneId: args.contactPhoneId,
          providerLegSid: created.sid,
        },
      });
      await recordPacingEvent(tx, {
        organizationId: args.organizationId,
        dialSessionId: args.dialSessionId ?? null,
        counters: { dialsInitiated: 1 },
      });
      return call.id;
    });
    return { callId, providerCallSid: created.sid };
  } catch (err) {
    logger.error(
      { err, providerCallSid: created.sid },
      "DB insert failed after Twilio create — orphan Twilio call; reconciliation will cancel it",
    );
    throw err;
  }
}
