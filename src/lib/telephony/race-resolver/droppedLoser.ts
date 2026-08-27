import type { PrismaClient } from "@prisma/client";

/**
 * Milestone 1b — losing-side handler for the two-legs-answer race.
 *
 * The leg that LOSES the advisory-lock race (see acquireWinner.ts) is marked
 * `dropped-loser` and played a short professional message before hangup. Both
 * the message text/mode and the MP3 URL are env-driven seams (see §5) so Ryan
 * can flip `<Say>` vs `<Play>` and edit the copy WITHOUT a code change.
 *
 * ⚠️ Ryan-decision blocker: the default text below is a placeholder proposed by
 * Agent B. It is NOT in shared context and NOT approved. TCPA-sensitive. A §13
 * planner request is filed at Milestone 1b for verbatim approval (or an MP3).
 */

const DEFAULT_LOSER_TEXT =
  "Sorry, our agent just stepped away. We'll call you back shortly.";

export interface LoserTwimlEnv {
  mode?: string; // RACE_LOSER_TWIML_MODE: "say" | "play" (default "say")
  text?: string; // RACE_LOSER_TWIML_TEXT
  mp3Url?: string; // RACE_LOSER_TWIML_MP3_URL
}

/**
 * Minimal XML escaper for the `<Say>` body. Twilio TwiML is XML; the operator
 * copy could in theory contain `&`/`<`/`>`/quotes. Keep the surface tiny.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Pure TwiML builder — no DB. Reads the env seam (defaults to process.env).
 * `say` mode → `<Say voice="Polly.Joanna">…</Say><Hangup/>`.
 * `play` mode → `<Play>…mp3…</Play><Hangup/>`.
 */
export function buildLoserTwiml(env: LoserTwimlEnv = {}): string {
  const mode = (env.mode ?? process.env.RACE_LOSER_TWIML_MODE ?? "say").toLowerCase();

  if (mode === "play") {
    const mp3 = env.mp3Url ?? process.env.RACE_LOSER_TWIML_MP3_URL ?? "";
    return `<Response><Play>${escapeXml(mp3)}</Play><Hangup/></Response>`;
  }

  // Default / "say" mode.
  const text = env.text ?? process.env.RACE_LOSER_TWIML_TEXT ?? DEFAULT_LOSER_TEXT;
  return `<Response><Say voice="Polly.Joanna">${escapeXml(text)}</Say><Hangup/></Response>`;
}

/**
 * Update the losing CallLeg to disposition='dropped-loser', droppedLoserMessage=true,
 * then return the TwiML that plays the message and hangs up.
 *
 * `providerLegSid` is the Twilio CallSid of the losing leg. Keyed on that so the
 * update is idempotent across webhook replays.
 */
export async function markLoserAndBuildTwiml(
  prisma: PrismaClient,
  legSid: string,
  env: LoserTwimlEnv = {},
): Promise<string> {
  await prisma.callLeg.updateMany({
    where: { providerLegSid: legSid },
    data: { disposition: "dropped-loser", droppedLoserMessage: true },
  });
  return buildLoserTwiml(env);
}
