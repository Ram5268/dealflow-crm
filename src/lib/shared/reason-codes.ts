// Re-export of the frozen compliance reason-code vocabulary. A does NOT define
// its own enum — the single source of truth is contracts/http/reason-codes.ts
// (planner-published, shared by all four slices). If this import ever fails,
// that's a contract-layer breakage, not something to patch locally.
export {
  REASON_CODES,
  reasonCodeSchema,
  type ReasonCode,
} from '../../../contracts/http/reason-codes'

import { REASON_CODES } from '../../../contracts/http/reason-codes'

// A depends on `timezone_unresolved` as its fail-closed fallback for the split
// timezone-semantics rule (brief §7). Assert its presence at module load so a
// contract drift surfaces loudly rather than silently breaking the queue.
if (!(REASON_CODES as readonly string[]).includes('timezone_unresolved')) {
  throw new Error(
    'REASON_CODES is missing "timezone_unresolved" — Agent A relies on it as the ' +
      'fail-closed fallback for unresolved timezones. STOP and notify the planner.'
  )
}

const REASON_CODE_SET = new Set<string>(REASON_CODES)

// True if every reason string is a member of the frozen enum. A phone whose
// reasons contain any unknown code is treated as a contract violation.
export function areReasonsKnown(reasons: readonly string[]): boolean {
  return reasons.every((r) => REASON_CODE_SET.has(r))
}

export function unknownReasons(reasons: readonly string[]): string[] {
  return reasons.filter((r) => !REASON_CODE_SET.has(r))
}
