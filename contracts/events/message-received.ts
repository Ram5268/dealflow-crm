// Compatibility shim. Agent D's brief imports the message.received schema from
// this dashed path; the canonical dotted file `message.received.ts` is the
// single source of truth. Flagged for planner in briefs/PREFLIGHT_NOTES.md.
export { MessageReceivedEvent } from './message.received'
