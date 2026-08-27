import { logger } from "@/lib/logger";

/**
 * Local Call.status vocabulary (frozen schema §6):
 *   created|in-progress|completed|cancel|no-answer|busy|failed|timeout
 *
 * Twilio's CallStatus vocabulary:
 *   queued|initiated|ringing|in-progress|completed|busy|no-answer|failed|canceled
 *
 * The load-bearing mapping is `canceled → cancel` (§6.1 item 3 — the frozen enum
 * lists `cancel`, Twilio emits `canceled`). A §13 request is filed to reconcile;
 * until then this explicit map is the sanctioned application-level workaround.
 */
export type LocalCallStatus =
  | "created"
  | "in-progress"
  | "completed"
  | "cancel"
  | "no-answer"
  | "busy"
  | "failed"
  | "timeout";

const TWILIO_TO_LOCAL: Record<string, LocalCallStatus> = {
  queued: "created",
  initiated: "created",
  ringing: "in-progress",
  "in-progress": "in-progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  failed: "failed",
  canceled: "cancel", // ← the reconciliation mapping
};

/** Local statuses that are terminal → trigger a `call.completed` emission. */
const TERMINAL_LOCAL: ReadonlySet<LocalCallStatus> = new Set<LocalCallStatus>([
  "completed",
  "no-answer",
  "busy",
  "failed",
  "cancel",
]);

/**
 * Map a Twilio CallStatus to our local Call.status. Returns null for an
 * unrecognized status and logs a warning (so we catch Twilio adding a value).
 */
export function mapTwilioStatus(twilioStatus: string): LocalCallStatus | null {
  const mapped = TWILIO_TO_LOCAL[twilioStatus];
  if (mapped === undefined) {
    logger.warn({ twilioStatus }, "Unknown Twilio CallStatus — no local mapping");
    return null;
  }
  if (twilioStatus === "canceled") {
    logger.info({ twilioStatus, mapped }, "Mapped Twilio 'canceled' → local 'cancel'");
  }
  return mapped;
}

export function isTerminalLocalStatus(status: LocalCallStatus): boolean {
  return TERMINAL_LOCAL.has(status);
}
