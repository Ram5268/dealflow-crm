// TCPA Shield HTTP status-code → treatment mapping (§2a). PROVISIONAL until the
// real API semantics are documented; planner reviews before ship. Until then,
// the ONLY "clean" path is a 2xx with a parseable body; every other code
// fails-closed. Do NOT add a "404 = clean" mapping without vendor confirmation.
export const TCPA_SHIELD_DNC_STATUS_CODES = {
  '2xx': 'parse body; per-phone dnc flag decides on-list vs clean',
  '400': 'vendor_error_dnc (bad request; fail-closed)',
  '401': 'vendor_error_dnc (auth; fail-closed — check DNC_API_KEY)',
  '403': 'vendor_error_dnc (forbidden; fail-closed)',
  '404': 'vendor_error_dnc (NOT clean until confirmed; fail-closed)',
  '429': 'retry w/ backoff (max 3) then vendor_error_dnc',
  '5xx': 'vendor_error_dnc (fail-closed)',
  timeout: 'vendor_error_dnc after 10s abort',
  malformed_json: 'vendor_error_dnc',
} as const
