# Wire-contract notes (Agent B)

Captures the planner-locked wire shapes (§8.3) + REASON_CODES (§8.4) + the S5
amendment, so the next session sees them without re-reading the brief.

## Event payloads on `crm_call` (all carry a `type` discriminant, no `eventName`)

**call.connected**
```
{ type:'call.connected', callId, dialSessionId, leadId|null, contactId|null,
  remotePhone, connectedAt(ISO), correlationId(uuid) }
```

**call.completed** — `cost` is DECIMAL-AS-STRING (not a number).
```
{ type:'call.completed', callId,
  disposition:'answered'|'vm-answer'|'vm-left'|'busy'|'blocked'|'error'|'abandoned'|'no-answer',
  duration:int|null, cost:string|null, outcomeId?:string|null, correlationId(uuid) }
```
- **§13 S4 (blessed):** `no-answer` added to the disposition enum. Twilio
  `no-answer` → `no-answer` (not `error`). `failed`/`cancel`/`timeout` → `error`.

**dial-session.pacing-update** — **§13 S5 (blessed 2026-08-27)**
```
{ type:'dial-session.pacing-update', callId?, sessionId, lineCount,
  rollingAbandonment,
  band:'below_1_5'|'1_5_to_2_0'|'2_0_to_2_5'|'2_5_to_2_8'|'above_2_8',
  reason:string, correlationId(uuid) }
```
- Kept `type` for crm_call channel consistency; added `band`+`reason` for Ops.
  Field names match the M1a control-law variables. No shipped consumer depended
  on the prior shape (Ops dashboard not built; A ignores unknown `type`).

## HTTP consumed

**GET /api/queue** (A) — bind `leadId`, `contactId`, `primaryPhoneE164`,
`primaryPhoneId` (needed for the compliance check; brief-required though only
additionalProperties in queue.json). `timezone` may be `null` — do NOT
synthesize; pass through so C fail-closes. Parse `.passthrough()`; `stale:true`
→ warn + proceed.

**POST /api/compliance/callable-now** (C) — send `{ contactPhoneIds:[id] }`, no
`atInstant`. Response entries carry BOTH `contactPhoneId` AND `phone`.
FAIL-CLOSED on any error/timeout/malformed/missing-phone → treat as
`callable:false`. Batch cap 100 (chunked; single-dial never hits it).

## REASON_CODES (frozen, imported from `contracts/http/reason-codes.ts`)

```
internal_dnc, federal_dnc, state_dnc, litigator,
outside_calling_window_hour, outside_calling_window_day,
holiday_federal, holiday_state, policy_unconfirmed,
timezone_unresolved, vendor_error, window_stale
```
- This is the SHELL's current list. Ryan ruled the canonical set = Brief C's
  Granular §7A (19 codes); the shell file updates on the next planner amendment
  and A/B/C converge automatically. B imports from the shell (source of truth)
  and Sentry-warns on any value outside it (still fail-closed).

## Env name locks
- `COMPLIANCE_BASE_URL` (matches A's shipped name, not `COMPLIANCE_SERVICE_BASE_URL`).
- `QUEUE_SERVICE_BASE_URL`.
- `TWILIO_MONTHLY_SPEND_CAP_USD` default **200** (§5 authoritative).
- `LOSER_TWIML_APPROVED` must be `'true'` before `method=predictive` sessions.
