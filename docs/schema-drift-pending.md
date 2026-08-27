# Schema-drift & contract-change requests (Agent B) — status

Per brief §13, every schema/contract change is a planner (Ryan) request. Agent B
does NOT self-apply schema edits. Below: each item, its status, and the
application-level workaround active until the planner responds.

## Filed at Milestone 1b

| # | Request | Status | Workaround in place |
|---|---------|--------|---------------------|
| L1 | **Dropped-loser TwiML text** — need Ryan-approved verbatim copy OR an MP3 URL; `<Say>` vs `<Play>`. TCPA-sensitive. | **PENDING** (Ryan: "keep placeholder + `<Say>` for now") | Env seam `RACE_LOSER_TWIML_MODE/_TEXT/_MP3_URL`; nothing hard-coded. Placeholder text ships. Predictive sessions gated on `LOSER_TWIML_APPROVED==='true'` (Milestone 4). |

## Filed at Milestone 2 — ALL BLESSED (Ryan, additive)

| # | Request | Status | Action |
|---|---------|--------|--------|
| S1 | **Composite `@@unique([callId, providerLegSid])` on CallLeg** for webhook replay-safety. | **BLESSED — add at integration migration** | Keep the `FOR UPDATE` + no-op idempotency workaround until the integration migration adds the constraint. |
| S2 | **`Call.source` default `"Close.io"` → `"dealflow-crm"`.** | **BLESSED (brief error)** | Keep explicit-on-insert until the schema default is flipped at integration. |
| S3 | **`Call.status`: `'cancel'` vs Twilio `'canceled'`.** | **BLESSED — no schema change** | It's a mapping decision, not a value change. Keep `statusMap.ts`. |
| S4 | **`call.completed.disposition` add `no-answer`.** | **BLESSED — DONE** | Added `no-answer` to `contracts/events/call.completed.ts` enum; `toEventDisposition` now maps Twilio `no-answer → no-answer` (was `error`). `failed/cancel/timeout → error`. |

## Pre-resolved in the frozen schema (no request needed)

- **`Call.emittedAt DateTime?`** — already present in `prisma/schema.prisma`.
  Confirmed by Ryan: the Milestone-5 request is moot. Lost-emission recovery
  (Milestone 5) wires directly to the real column — **no in-memory outbox
  sentinel; workaround dropped.**

## Cross-slice contract observations (flag, not self-fix)

- **`REASON_CODES` divergence.** The shell's `contracts/http/reason-codes.ts`
  differs from brief §8.4 (shell has `holiday_federal/holiday_state/
  policy_unconfirmed/window_stale`; brief lists `holiday_suppression/
  mobile_line_blocked/phone_missing/phone_invalid/unsubscribed/internal_error`).
  Ryan confirmed the canonical list = Brief C's Granular §7A 19-code set; the
  shell file updates on the next planner amendment and A/B/C converge. Agent B
  imports from the shell contract (source of truth) and treats unknown codes as
  a §13 event at Milestone 4/6. **No action for B now.**
- **`COMPLIANCE_SERVICE_BASE_URL` → `COMPLIANCE_BASE_URL`.** RESOLVED: Ryan
  ruled A's shipped name (`COMPLIANCE_BASE_URL`) wins. B renamed in `.env.example`
  and will use `COMPLIANCE_BASE_URL` in the Milestone-4 dial loop.
- **`TWILIO_MONTHLY_SPEND_CAP_USD`** — RESOLVED: 200 wins (§5 authoritative).
  `.env.example` updated 500 → 200.
