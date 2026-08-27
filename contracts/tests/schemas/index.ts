// Barrel re-export of every shared contract schema. Import from here in
// contract tests and slice consumers so there is one canonical entry point.

// Event payloads (Postgres LISTEN/NOTIFY)
export { CallConnectedEvent } from '../../events/call.connected'
export { CallCompletedEvent } from '../../events/call.completed'
export { PacingUpdateEvent } from '../../events/dial-session.pacing-update'
export { ScrubCompletedEvent } from '../../events/scrub.completed'
export { MessageReceivedEvent } from '../../events/message.received'
export { LeadUpsertedFromImportEvent } from '../../events/lead.upserted-from-import'
export { LeadDerivedSignalsSyncedEvent } from '../../events/lead.derived-signals-synced'

// HTTP compliance vocabulary
export { REASON_CODES, reasonCodeSchema } from '../../http/reason-codes'
export type { ReasonCode } from '../../http/reason-codes'
