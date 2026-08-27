import { prisma } from "@/lib/prisma";
import { verifyTwilioWebhook } from "@/lib/telephony/twilio/signature";
import { handleStatusWebhook, type StatusWebhookParams } from "@/lib/telephony/twilio/statusWebhook";

const XML_HEADERS = { "content-type": "text/xml" };

/**
 * Twilio call-progress status webhook. Idempotent on CallSid; emits
 * call.completed on terminal statuses. Always signature-validated; 403 on failure.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const url = `${process.env.TWILIO_VOICE_WEBHOOK_BASE ?? ""}/status`;
  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioWebhook(signature, url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  await handleStatusWebhook(prisma, params as StatusWebhookParams);
  return new Response("<Response/>", { status: 200, headers: XML_HEADERS });
}
