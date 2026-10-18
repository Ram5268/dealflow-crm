/**
 * Brief 41.2 (PR D) — the CRM's Outlook (Microsoft Graph) off-switch.
 *
 * Ryan's instruction: Outlook stays on hard pause; switch name confirmed by
 * Ryan 2026-10-17. It is GRAPH_ENABLED, the same name DealFlow uses
 * (lib/graphAccess.ts), so one setting means "Outlook allowed" in both apps.
 *
 * On only when GRAPH_ENABLED is exactly 'true'; unset, empty, 'TRUE', '1' or a
 * typo all mean OFF (an engineering precaution, matching EMAIL_ENABLED,
 * SMS_ENABLED and DIALING_ENABLED). While it is off nothing reaches Microsoft:
 * no sign-in, no code exchange, no token refresh or storage, no mail sync and
 * no send, whatever EMAIL_ENABLED says. Disconnect stays allowed: Outlook is
 * revoked locally only, with no Microsoft call.
 */

export function graphEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GRAPH_ENABLED === 'true'
}

export const GRAPH_DISABLED = {
  error: 'outlook_paused',
  message: 'Outlook is paused (GRAPH_ENABLED is not true). The CRM did not contact Microsoft.',
} as const

export class GraphDisabledError extends Error {
  readonly code = GRAPH_DISABLED.error
  constructor() {
    super(GRAPH_DISABLED.message)
    this.name = 'GraphDisabledError'
  }
}

/** The 403 the Outlook sign-in routes return while Outlook is paused. */
export function graphDisabledResponse(): Response {
  return Response.json(GRAPH_DISABLED, { status: 403 })
}
