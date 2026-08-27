import { verifyTwilioWebhook } from "@/lib/telephony/twilio/signature";
import { buildOperatorConferenceTwiml } from "@/lib/telephony/twilio/twiml";

const XML_HEADERS = { "content-type": "text/xml" };

/**
 * Operator-side conference TwiML app URL. The browser Voice-SDK client's
 * `device.connect({ params: { conferenceName } })` resolves here; Twilio POSTs
 * the `conferenceName` param and we return the <Conference> TwiML that joins the
 * operator into `conf_<callId>`. Signature-validated.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const url = `${process.env.TWILIO_VOICE_WEBHOOK_BASE ?? ""}/../voice/conference`;
  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioWebhook(signature, url, params)) {
    return new Response("invalid signature", { status: 403 });
  }

  const conferenceName = params.conferenceName ?? "";
  return new Response(buildOperatorConferenceTwiml(conferenceName), {
    status: 200,
    headers: XML_HEADERS,
  });
}
