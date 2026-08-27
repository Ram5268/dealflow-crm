# Cross-Brief Consistency Review

## Inter-brief Inconsistencies (must-fix)

### 1. `message.received` payload shape — CRITICAL
**Brief A §6** ("Events YOU CONSUME") documents A consumes: `{ messageId, channel, contactId?, leadId?, correlationId }` — matches SHARED_CONTEXT.
**Brief D §8** explicitly forbids an `eventName` field: "The `message.received` payload does NOT include an `eventName` field."
**Brief B §7.1** (informational, doesn't emit this) — no conflict.
**Brief A §6 emissions**, however, shows A's OWN emitted payloads (`lead.upserted-from-import`, `lead.derived-signals-synced`) DO include `eventName` fields. This is a fan-in/fan-out inconsistency: A emits with `eventName`, D emits without. Consumers must handle both shapes, or the convention must be unified.
**Fix:** planner must lock ONE convention. Recommend: drop `eventName` everywhere (SHARED_CONTEXT §5 schemas don't include it); A rewrites its own emitters. Brief B §7.1 also uses `type` discriminant field — third variant. Standardize on channel-as-routing-signal, no discriminant in payload.

### 2. `call.completed` payload — `cost` type mismatch
**Brief B §7.1** Zod: `cost: z.string().nullable()` (decimal-as-string).
**SHARED_CONTEXT §5** and **Brief A §6** don't specify the type.
**Fix:** A's activity projector must accept string-decimal, not `number`. Brief A should annotate this explicitly. Planner should publish the wire type in `contracts/events/call.completed.ts`.

### 3. Queue endpoint response shape — field name drift
**Brief A §7** returns per-lead: `primaryPhone: string` (E.164).
**Brief B §8.2** expects per-lead: `primaryPhoneE164: string`.
**Fix:** pick one. Recommend `primaryPhoneE164` (self-documenting). Rename in A.

### 4. Queue endpoint — extra fields B doesn't know about
**Brief A §7** response includes `excludedNoPhone`, `excludedCompliance`, `stale`, `staleReason`, `displayName`, `timezone`.
**Brief B §8.2** schema omits all of these.
**Fix:** B is doing a subset-parse (fine for JSON), but contract tests in B (`consumes.queue.mock.test.ts`) will fail against A's real service unless B's schema is updated. Add fields to B's consumed schema OR mark schema as `.passthrough()`.

### 5. `scrub.completed` payload — payload consistency
**Brief A §6** says handler is a no-op observability logger; "payload as documented in shared context has no phone list."
**Brief C §6** emits: `{ phoneCount, blockedCount, checkedAt, correlationId }` — matches SHARED_CONTEXT.
Consistent. But A idempotency key is `scrub.completed:${correlationId}` — fine.

### 6. `POST /api/compliance/callable-now` — batch cap mismatch
**Brief A §7** locks batch cap at **100** and the mock rejects >100 with HTTP 413.
**Brief C §7.2** does not mention a batch cap.
**Brief B §8.2** does not mention a batch cap.
**Fix:** C must enforce the 100 cap in its real implementation, or A's contract test against C at integration will fail. Planner must add `maxItems: 100` on `contactPhoneIds` to `contracts/http/compliance-callable-now.json` (A committed to do so; C must honor it).

### 7. `POST /api/compliance/callable-now` — response field name mismatch
**Brief A §7** consumed: `{ results: [{ phone, callable, reasons }] }`.
**Brief B §8.2** consumed: `{ results: [{ contactPhoneId, phone, callable, reasons }] }`.
**Brief C §7.2** exposed: `{ results: [{ contactPhoneId, callable, reasons, reasonDetails? }] }` — notably NO `phone` field.
**Fix:** three different shapes. Planner must lock. Recommend C's shape + add `phone` back (both A and B expect it). Also `reasonDetails` (C only) needs to be published so A/B know about it.

### 8. `POST /api/compliance/dnc/internal` — existence question
**Brief D Blocking Issue B.1** flags this as UNCONFIRMED.
**Brief C §2** lists it as an exposed endpoint: `POST /api/compliance/dnc/internal`. **CONFIRMED by C.**
**Brief A** doesn't reference this endpoint.
**Fix:** Resolved — endpoint exists per C's brief. D should proceed with HTTP path, NOT the `sms.stop-received` event fallback. Planner should confirm to D.

### 9. `POST /api/compliance/dnc/internal` — response shape mismatch
**Brief C §7.4** response 201: `{ id, phone, source: "internal", addedAt }`.
**Brief D §9** expects response: `{ dncId: string, added: boolean }`.
**Fix:** contradictory. Planner must lock. D's `added: boolean` distinguishes idempotent-already-existed vs new — useful telemetry. C should adopt: `{ id, phone, source, addedAt, added: boolean }`.

### 10. `reasons[]` vocabulary — B doesn't know about REASON_CODES
**Brief C §7A** locks a frozen enum: `internal_dnc`, `federal_dnc`, `state_dnc`, `litigator`, `outside_calling_window_hour`, etc.
**Brief B §8.2** just types as `reasons: string[]` with no vocabulary.
**Brief A §7** same — just `string[]`.
**Fix:** planner must publish REASON_CODES centrally. A and B contract tests should assert reason values are drawn from that enum.

### 11. `Lead.source` convention — cross-agent commitment
**Brief C §2** says `Lead.source = "import:" + importBatchId` for bulk-scrub enumeration, and explicitly calls this out as needing planner ratification.
**Brief A §7** (importer proposed-mapping) doesn't specify what it writes to `Lead.source`. SHARED_CONTEXT example: `"mojo-import-2026-08-29"`.
**Fix:** A must commit to `"import:" + importBatchId` OR C must enumerate a different way. Currently a silent break at integration. Planner must lock.

### 12. `Message.status` enum — Twilio delivery states
**Brief D Blocking Issue B.3** flags: schema enum is `inbox|draft|scheduled|outbox|sent|error`, Twilio emits `queued|sent|delivered|undelivered|failed`. D defaults to adding `providerDeliveryState` column.
**Brief A** doesn't reference this.
**Fix:** planner must lock. Recommend D's option (b) — new column, don't reshape frozen enum.

### 13. `OAuthCredential` model — schema addition
**Brief D Blocking Issue B.2** flags this as an unratified schema addition.
**Fix:** planner must add to shared schema BEFORE D's Milestone 2.1. Currently blocking.

### 14. `crm_lead_sync` consumer — D adds a new consumer relationship
**Brief D §8** consumes `lead.upserted-from-import` to trigger thread reconcile.
**Brief A §6** emits it but expects only A itself as consumer ("A (activity projector)").
**Fix:** SHARED_CONTEXT table needs updating to list D as consumer. Not a break, but the contract catalog is out of sync.

### 15. `ScrubLog.operation` enum extension
**Brief C §5** extends vocabulary with `check-holiday`, `check-mobile-line` — planner ratification required.
Consistent, but SHARED_CONTEXT and other briefs must be updated.

### 16. `sms.stop-received` event — new event on `crm_scrub` channel
**Brief D §8** proposes emitting `sms.stop-received` on `crm_scrub` (fallback path).
**Brief C §2** says "Events consumed: **None**."
**Fix:** confirmed unnecessary — B.1 resolved to HTTP path. Ensure D doesn't accidentally implement fallback.

### 17. `dial-session.pacing-update` — no documented consumer
**Brief B §7.1** emits on `crm_call` channel.
**Brief A §6** consumes `crm_call` but NOT this event — A only handles `call.connected` / `call.completed`.
SHARED_CONTEXT §5 says consumer is "Ops dashboard."
**Fix:** benign; A should ignore unknown event types. Verify A's listener dispatcher doesn't crash on unrecognized `type` field.

## Coverage Gaps

### G1. `GET /api/telephony/calls/:id/ammunition` requires cross-slice reads
Brief B §8.1 SELECTs from `Lead` and `DealFlowDerivedSignal` (Agent A tables). Brief A doesn't explicitly ratify B reading these tables. Per SHARED_CONTEXT §4 ("Agents CAN read any table"), this is allowed — no gap, just worth noting B must import Prisma types A owns.

### G2. Timezone default fallback — inconsistent
Brief A §7 "Effective timezone rule": `Contact.timezone ?? Lead.timezone ?? 'America/New_York'`.
Brief C §11 explicitly forbids fallback: "runtime NEVER falls back to a default timezone for a real contact. Missing timezone → callable:false."
Brief D §10 sequence tick: falls back to `America/New_York` if `Contact.timezone` is null.
**Fix:** A's queue and D's sequences will pass timezone `America/New_York` for null-tz contacts; C will fail-closed because it doesn't fall back. Result: `/api/queue` returns leads that C then blocks with `timezone_unresolved`. Not broken (fail-closed is correct), but A should NOT populate a fake timezone — it should let C decide. Planner must clarify: is fallback at the display layer only, or does it enter the compliance check?

### G3. `Call.emittedAt` schema addition
Brief B §7.3 requires this for lost-emission recovery, filed as §13 request. Not in SHARED_CONTEXT §5 schema. Blocking Milestone 5. Planner must ratify.

### G4. `BulkScrubCheckpoint` new table (Agent C)
Brief C §5 introduces it, planner ratification required. Not in SHARED_CONTEXT.

### G5. Ammunition panel field `primaryAddressSummary`
Brief B §8.1 ammunition response references `Lead.primaryAddressSummary`. Brief A §5 schema has this field. Consistent.

### G6. Playwright dependency
Brief A §9 M9 uses Playwright for E2E. Not mentioned in SHARED_CONTEXT stack. Fine as dev-only.

## Approvals

- **Brief A** — **partially consistent.** Field-name drift with B on queue response (`primaryPhone` vs `primaryPhoneE164`); own emissions include `eventName` field that D's emissions omit; timezone fallback semantics conflict with C.
- **Brief B** — **partially consistent.** Consumed-mock schemas for `/api/queue` and `/api/compliance/callable-now` don't match A's/C's exposed shapes (missing/extra fields); reasons vocabulary untyped; ready-consumer for `dial-session.pacing-update` unspecified.
- **Brief C** — **partially consistent.** `dnc/internal` response shape conflicts with D's expectation; `callable-now` response omits `phone` field that A and B both expect; batch-cap 100 not published; `Lead.source` convention is an unratified Agent A commitment.
- **Brief D** — **partially consistent.** Two Blocking Issues (B.2 OAuthCredential, B.3 Message.status) are legitimate planner-owned. B.1 is resolved (C confirms endpoint exists). `dnc/internal` response shape conflicts with C.

**Overall:** the four briefs are internally rigorous but drifted on ~8 concrete wire-level shapes. None are catastrophic (all catchable at Gate 2 contract tests IF the schemas are published centrally). Highest-priority planner actions: (1) publish `REASON_CODES` centrally; (2) lock `callable-now` response shape (include `contactPhoneId` AND `phone`); (3) lock `dnc/internal` response shape; (4) standardize event payload discriminant (drop `eventName`); (5) ratify `OAuthCredential`, `BulkScrubCheckpoint`, `Call.emittedAt`, and `ScrubLog.operation` vocabulary additions; (6) rename `primaryPhone` → `primaryPhoneE164` in A's queue response; (7) publish `Lead.source = "import:" + importBatchId` convention as an A-side commitment; (8) resolve timezone fallback semantics (fail-closed everywhere, or fallback everywhere — pick one).