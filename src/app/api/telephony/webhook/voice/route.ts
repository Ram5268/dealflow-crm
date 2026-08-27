import { prisma } from "@/lib/prisma";
import { verifyTwilioWebhook } from "@/lib/telephony/twilio/signature";
import { handleAmdWebhook, type AmdWebhookParams } from "@/lib/telephony/twilio/voiceWebhook";
import { buildPauseTwiml } from "@/lib/telephony/twilio/twiml";

const XML_HEADERS = { "content-type": "text/xml" };

/**
 * Twilio voice webhook. First POST (no AnsweredBy) → Pause while async AMD runs.
 * Second POST (asyncAmdStatusCallback, carries AnsweredBy) → race-resolver.
 * Always signature-validated; 403 on failure.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const url = `${process.env.TWILIO_VOICE_WEBHOOK_BASE ?? ""}/voice`;
  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioWebhook(signature, url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  if (!params.AnsweredBy) {
    return new Response(buildPauseTwiml(), { status: 200, headers: XML_HEADERS });
  }

  const correlationId = req.headers.get("x-correlation-id") ?? undefined;
  const result = await handleAmdWebhook(prisma, params as AmdWebhookParams, correlationId);
  return new Response(result.twiml, { status: 200, headers: XML_HEADERS });
}
