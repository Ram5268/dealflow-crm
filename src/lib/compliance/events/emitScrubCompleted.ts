import { ScrubCompletedEvent } from '../../../../contracts/events/scrub.completed'

// Emit `scrub.completed` on the Postgres LISTEN/NOTIFY channel `crm_scrub`.
// MUST run inside the SAME transaction as the ScrubLog / suppression writes so
// a rolled-back scrub never notifies a listener of a decision that didn't
// commit. Channel-as-routing: NO eventName/type discriminant in the payload.
//
// camelCase field names, validated against the frozen Zod schema before the
// wire write — a snake_case slip is a Gate 2 failure, so we fail fast here.

export interface ScrubCompletedPayload {
  phoneCount: number
  blockedCount: number
  checkedAt: string // ISO 8601 UTC
  correlationId: string // uuid v4
}

// The tx client (or base client) — only needs $executeRaw. Structural type so
// tests can inject a fake that records the emitted JSON.
export interface NotifyTx {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
}

export async function emitScrubCompleted(payload: ScrubCompletedPayload, tx: NotifyTx): Promise<void> {
  const validated = ScrubCompletedEvent.parse(payload)
  const json = JSON.stringify(validated)
  // pg_notify parameterizes the payload safely (no manual escaping).
  await tx.$executeRaw`SELECT pg_notify('crm_scrub', ${json})`
}
