import type { PrismaClient } from "@prisma/client";
import type { QueueResponse, CallableResult } from "./schemas";
import type { PlaceCallArgs } from "./placeCall";
import { eligibleLeads } from "./nextContact";
import { logger } from "@/lib/logger";

/**
 * Injected collaborators — lets the dial tick be exercised headlessly without
 * real HTTP or Twilio. Defaults wire the real queue/compliance/placeCall.
 */
export interface DialTickDeps {
  getQueue: (viewId: string, limit?: number) => Promise<QueueResponse>;
  checkCallable: (contactPhoneIds: string[]) => Promise<CallableResult[]>;
  placeCall: (args: PlaceCallArgs) => Promise<{ callId: string; providerCallSid: string }>;
}

export interface DialSessionRow {
  id: string;
  organizationId: string;
  userId: string | null;
  method: string;
  lineCount: number;
  callerId: string;
  sourceValue: string; // SavedView id → queue viewId
  status: string;
}

export interface DialTickResult {
  placed: number;
  blocked: number;
  paused: boolean;
}

/** Count outbound calls for a session that are still live (occupying a line). */
async function inFlightCount(prisma: PrismaClient, sessionId: string): Promise<number> {
  return prisma.call.count({
    where: { dialSessionId: sessionId, status: { in: ["created", "in-progress"] } },
  });
}

/**
 * Run ONE dial-loop iteration for a session: fill open line slots by pulling
 * from A's queue, applying the local dropped-loser exclusion, checking Agent C
 * inline (fail-closed) per phone, and placing calls for callable phones.
 *
 * Compliance is per-dial (one id at a time) — the 100 batch cap never bites.
 * `atInstant` is never sent. A non-callable phone is logged as
 * `compliance_blocked` and skipped; we move to the next contact.
 */
export async function runDialTick(
  prisma: PrismaClient,
  session: DialSessionRow,
  deps: DialTickDeps,
): Promise<DialTickResult> {
  if (session.status !== "active") return { placed: 0, blocked: 0, paused: false };

  const inFlight = await inFlightCount(prisma, session.id);
  const slots = Math.max(session.lineCount - inFlight, 0);
  if (slots === 0) return { placed: 0, blocked: 0, paused: false };

  const queue = await deps.getQueue(session.sourceValue, 50);
  if (queue.leads.length === 0) {
    await prisma.dialSession.update({ where: { id: session.id }, data: { status: "paused" } });
    logger.info({ sessionId: session.id }, "queue empty — pausing session");
    return { placed: 0, blocked: 0, paused: true };
  }

  const eligible = await eligibleLeads(prisma, queue.leads);
  let placed = 0;
  let blocked = 0;

  for (const lead of eligible) {
    if (placed >= slots) break;
    const contactPhoneId = lead.primaryPhoneId as string; // eligibleLeads guarantees present

    const [result] = await deps.checkCallable([contactPhoneId]);
    if (!result || !result.callable) {
      blocked += 1;
      logger.warn(
        { contactPhoneId, reasons: result?.reasons ?? ["internal_error"] },
        "compliance_blocked — skipping contact",
      );
      continue;
    }

    await deps.placeCall({
      organizationId: session.organizationId,
      userId: session.userId,
      leadId: lead.leadId,
      contactId: lead.contactId,
      dialSessionId: session.id,
      callMethod: session.method as PlaceCallArgs["callMethod"],
      callerId: session.callerId,
      toPhone: lead.primaryPhoneE164,
      contactPhoneId,
    });
    placed += 1;
  }

  return { placed, blocked, paused: false };
}
