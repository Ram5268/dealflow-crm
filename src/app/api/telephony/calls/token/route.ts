import { buildVoiceToken } from "@/lib/telephony/twilio/voiceToken";
import { dialingEnabled, dialingDisabledResponse } from "@/lib/telephony/dialingSwitch";

/**
 * Issue a Twilio Voice SDK access token for the browser softphone. Identity is
 * derived from the authenticated user (MVP: single seat → `x-user-id` header or
 * default). TTL 1 hour.
 */
export async function POST(req: Request): Promise<Response> {
  if (!dialingEnabled()) return dialingDisabledResponse(); // Brief 37 calling switch
  const userId = req.headers.get("x-user-id") ?? "ryan";
  const identity = `user_${userId}`;
  try {
    const result = buildVoiceToken({ identity });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: "token_unavailable", detail: (err as Error).message },
      { status: 503 },
    );
  }
}
