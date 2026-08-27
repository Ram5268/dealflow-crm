/**
 * Pure TwiML builders for the voice webhook. Kept dependency-free so they are
 * trivially unit-testable. The dropped-loser TwiML lives in race-resolver/
 * droppedLoser.ts (it reads the env seam).
 */

/** First voice POST: hold the call while async AMD decides. */
export function buildPauseTwiml(seconds = 30): string {
  return `<Response><Pause length="${seconds}"/></Response>`;
}

/** Machine/fax answer: hang up, no bridge. */
export function buildHangupTwiml(): string {
  return `<Response><Hangup/></Response>`;
}

/**
 * Winner leg: dial the callee into the per-call conference room. The operator's
 * Voice-SDK client joins the same `conf_<callId>` from the browser (Milestone 3).
 * `endConferenceOnExit=false` on the callee side so the room survives brief
 * operator reconnects; the operator side sets it true.
 */
export function buildConferenceTwiml(callId: string): string {
  return (
    `<Response><Dial><Conference startConferenceOnEnter="true" ` +
    `endConferenceOnExit="false">conf_${callId}</Conference></Dial></Response>`
  );
}
