// Internal re-export of the centrally-published compliance vocabulary.
// The SINGLE source of truth lives at contracts/http/reason-codes.ts (imported
// by Agents A and B too). Slice code imports from here for a stable
// `@/lib/compliance/reasons` path; never redeclare the list.
export { REASON_CODES, reasonCodeSchema } from '../../../contracts/http/reason-codes'
export type { ReasonCode } from '../../../contracts/http/reason-codes'
