import { prisma } from "@/lib/prisma";
import { verifyTwilioWebhook } from "@/lib/telephony/twilio/signature";
import { storeRecording } from "@/lib/telephony/twilio/recording";
import { logger } from "@/lib/logger";

/**
 * Twilio recording-status callback. On RecordingStatus=completed, fetch the MP3
 * and store it in R2 (keyed on our callId, resolved via providerCallSid).
 * Signature-validated; R2 failure never fails the call.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const url = `${process.env.TWILIO_VOICE_WEBHOOK_BASE ?? ""}/recording`;
  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioWebhook(signature, url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  if (params.RecordingStatus !== "completed") {
    return new Response("<Response/>", { status: 200, headers: { "content-type": "text/xml" } });
  }

  const call = await prisma.call.findUnique({
    where: { providerCallSid: params.CallSid },
    select: { id: true },
  });
  if (!call) {
    logger.warn({ callSid: params.CallSid }, "recording webhook for unknown CallSid");
    return new Response("<Response/>", { status: 200, headers: { "content-type": "text/xml" } });
  }

  await storeRecording(prisma, {
    callId: call.id,
    recordingUrl: params.RecordingUrl,
    recordingDurationSec: params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : undefined,
  });

  return new Response("<Response/>", { status: 200, headers: { "content-type": "text/xml" } });
}
