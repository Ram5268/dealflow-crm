/** The `crm_call` SSE frames the dialer reacts to. Other fields are ignored. */
export interface CallStreamEvent {
  type?: string;
  callId?: string;
}

/**
 * Reduce one `crm_call` event onto the dialer's active call id.
 *
 * Extracted as a pure function for two reasons. First, it is the whole fix for
 * the closure bug below, because a pure reducer is only ever reachable through
 * a functional state updater. Second, it makes the transition testable in the
 * node test environment — DialerShell itself pulls in @twilio/voice-sdk and
 * cannot be mounted there.
 *
 * The bug it replaces: DialerShell subscribed with `useEffect(…, [])` and then
 * compared `evt.callId === activeCallId` inside the handler. That closure
 * captured `activeCallId` from the mount render, where it is null, so the
 * `call.completed` branch could never match and the ammunition panel stayed
 * stuck on a finished call.
 */
export function nextActiveCallId(current: string | null, evt: CallStreamEvent): string | null {
  if (!evt.callId) return current;
  // A new connect always wins, even if a previous call never reported completion.
  if (evt.type === "call.connected") return evt.callId;
  // Only the call we are actually on can clear the panel.
  if (evt.type === "call.completed" && evt.callId === current) return null;
  return current;
}
