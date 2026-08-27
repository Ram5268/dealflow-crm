/**
 * Async AMD (Answering Machine Detection) result parsing.
 *
 * Twilio's `AnsweredBy` values (machineDetection: 'DetectMessageEnd', asyncAmd):
 *   human | machine_start | machine_end_beep | machine_end_silence |
 *   machine_end_other | fax | unknown
 *
 * CallLeg.amdResult is stored as one of: machine | human | unknown (frozen §6).
 *
 * Routing rule (brief §10 Milestone 2):
 *   - human / unknown → BRIDGE: attempt tryAcquireCallWinner; if won, dial the
 *     operator's conference; if lost, play the dropped-loser TwiML.
 *   - machine_* / fax → HANGUP: CallLeg + Call disposition = 'vm-answer'.
 */
export type AmdResult = "machine" | "human" | "unknown";

export interface ParsedAmd {
  /** Normalized value written to CallLeg.amdResult. */
  amdResult: AmdResult;
  /** True → route into the operator bridge (human/unknown). */
  bridge: boolean;
  /** Disposition to set when NOT bridging (machine/fax → voicemail answer). */
  vmDisposition?: "vm-answer";
  /** The raw AnsweredBy, preserved for logging/idempotency keying. */
  raw: string;
}

const MACHINE_VALUES = new Set([
  "machine_start",
  "machine_end_beep",
  "machine_end_silence",
  "machine_end_other",
  "fax",
]);

export function parseAmd(answeredBy: string | undefined | null): ParsedAmd {
  const raw = answeredBy ?? "unknown";

  if (raw === "human") {
    return { amdResult: "human", bridge: true, raw };
  }
  if (MACHINE_VALUES.has(raw)) {
    return { amdResult: "machine", bridge: false, vmDisposition: "vm-answer", raw };
  }
  // "unknown" and any unrecognized value → treat as human path (bridge). This is
  // the FAIL-SAFE-FOR-THE-CALLEE choice: never silently drop a live human as a
  // machine; if AMD is unsure, connect the operator.
  return { amdResult: "unknown", bridge: true, raw };
}
