## Summary

Agent D — **Communications slice**: two-way email, SMS (behind a 10DLC flag),
reusable templates, and a blackout/DST-aware sequence engine. Both email providers
run through **one** reconstruction / dedup / persist path — only the client + cursor
differ. Milestones:

- **M1 — 10DLC packet**: brand + campaign registration content prepared for Ryan to
  file (`docs/10dlc-status.md`); SMS ships **parked** behind `SMS_ENABLED=false`.
- **M2 — Gmail**: AES-256-GCM token store + HMAC-signed OAuth state, RFC5322/Gmail
  parse, thread reconstruction, full-backfill + historyId delta sync over a
  provider-agnostic `SyncPorts` port.
- **M3 — sequences**: merge-field template render + luxon blackout/DST scheduler +
  per-enrollment-isolated tick (render → insert → enqueue).
- **M3.5 — send worker**: provider-routed send with **pre-set-before-send** dedup
  (mint the message id *inside the tx, before the network call* → no race window).
- **M4 — SMS**: REST Twilio (no SDK), `X-Twilio-Signature` verify, STOP → internal
  DNC. Three fail-safes before Twilio (flag → 10DLC config fail-fast → compliance
  scrub fail-closed).
- **M5 — Microsoft Graph mirror**: MSFT identity + Graph REST via `fetch` (same
  mockable pattern as Twilio, no SDK dep), conversationId/deltaLink cursor, draft +
  send. Reuses M2's reconstruction/dedup/persist path wholesale.
- **CRUD APIs**: templates, sequences (+ steps), enrollments (enroll / pause /
  resume / cancel), Zod-validated.

Gate 1 (isolation boot: app + 4 mocks, all `/health` 200) · Gate 3 (behavioral
smokes + coverage floors, **both providers**). 234 tests, `tsc --noEmit` clean, no
iCloud ` 2.ts` duplicates, no `.env` committed.

## Contract exposures (this slice)

- **Emits** (channel `crm_message`): `message.received`. **No `eventName`/`type`
  discriminant** on the wire — routing is `(channel, payload-shape)`, matching the
  fleet convention. Every NOTIFY is validated against the frozen `message.received`
  Zod schema before `pg_notify` (`events.ts`).
- **Consumes**: none via event. Two runtime cross-slice touches, both narrow:
  - **The ONE cross-slice write** — SMS STOP → `POST /api/compliance/dnc/internal`
    (C) `{ phoneE164, reason:'sms_stop_received', addedBy:'sms-inbound-handler' }`.
    Reads C's `added:boolean` for telemetry. D writes **no** A/B/C table directly.
  - **Prisma SELECT** on A's `Contact` / `ContactEmail` for inbound contact
    resolution during thread reconstruction — read-only, never HTTP, never a write.
- **HTTP** (D-owned, under `/api/comms` + `/api/cron`):
  - OAuth: `/comms/oauth/gmail/{authorize,callback}`, `/comms/oauth/msft/{authorize,callback}`
  - `/comms/messages`, `/comms/templates`(+`/[id]`), `/comms/sequences`(+`/[id]`,`/[id]/steps`),
    `/comms/enrollments`(+`/[id]`)
  - Webhooks: `/comms/webhook/sms`, `/comms/webhook/gmail-push`
  - `/comms/health`
  - Crons (bearer `CRON_SECRET`): `/cron/gmail-sync`, `/cron/graph-sync`, `/cron/sequences-tick`

## §13 amendments in this slice

- **`OAuthCredential` +5 nullable sync-state columns** (D-owned, planner-approved
  additive 2026-08-27): `emailAddress`, `gmailHistoryId`, `graphDeltaLink`,
  `gmailWatchExpiresAt`, `status @default("active")`. Only D reads/writes
  `OAuthCredential`, so zero cross-agent blast radius. GCM ciphertext is packed
  (`iv.tag.ct`) into the existing token columns → **no per-field IV/tag columns**.
  This is D's **entire** schema delta vs A's frozen baseline (see below).
- **`Message.providerDeliveryState`** — **already present in A's `initial`
  migration** (`20260827045415_initial`, line 486). No D migration needed; flagged
  here for the merge spot-check.
- **Organization back-relations** on `Message` / `EmailThread` / `MessageTemplate` /
  `Sequence` — additive opposite-field relations, already baked into A's `initial`.
  No delta.

> **Verified against `origin/agent-a`:** A's `initial` creates every D-owned table
> (`Message`, `EmailThread`, `MessageTemplate`, `Sequence`, `SequenceStep`,
> `SequenceEnrollment`) and `Message.providerDeliveryState`. A's `OAuthCredential`
> has the **base** columns only. So D's post-rebase migration is exactly a
> **5-column `ALTER TABLE "OAuthCredential" ADD COLUMN …`** — nothing else. See
> "Notes for the merge."

## Cross-slice notes

- **Both providers, one path.** `gmail-sync.ts` is provider-agnostic orchestration
  over `SyncPorts`; Gmail and Graph share the reconstruction, dedup, and persist
  ports. Only the client + cursor differ (Gmail threadId/historyId, Graph
  conversationId/deltaLink). **Graph is REST/`fetch`, not the SDK** — same
  configurable-base-URL mockability as Twilio.
- **`internetMessageId` dedup — one live check owed.** Sent-mail dedup keys
  `providerMessageId` on a pre-set client-side id (Gmail: RFC5322 `Message-ID`;
  Graph: `internetMessageId` on the draft) so the Sent-folder re-sync short-circuits
  on the `@unique`. Graph honoring `internetMessageId`-on-draft is **assumed**;
  post-Azure-cred acceptance step + fallback (client-side id + provider-message-id
  upsert-check before send) documented in `docs/agent-d-handoff.md`.
- **SMS parked.** `SMS_ENABLED=false` until the 10DLC campaign clears; the flip is a
  runtime config change, not a code change. Gated three ways: `SMS_ENABLED` →
  `requireTwilioConfig` (fail-fast on missing 10DLC SIDs) → compliance scrub
  (fail-closed).
- **REASON_CODES convergence at rebase.** D's SMS-path compliance scrub currently
  fail-closes with `vendor_error` (the frozen value at build time). C's PR #2 splits
  `vendor_error` into the granular 19-code enum
  (`vendor_error_dnc|_litigator|_mobile_line|_not_configured`, + `compliance_unavailable`).
  At the rebase, converge D's fail-closed reason to C's granular code — tolerant, and
  never a positive signal from a failure.
- **`jobs/` dir is coverage-exempt.** `boss.ts`, `gmail-runner.ts`, `graph-runner.ts`,
  `*-delta.ts` are pg-boss infra (the singleton resists mocking) — covered by
  `worker:smoke`, intentionally **outside** the brief's coverage-floor set
  (`email/sequences/sms/templates`), not an oversight.
- **Test-infra posture** (adopt A's shared-Railway-DB stance for DB-backed smokes):
  `isolate:false`, `maxWorkers:1`, `pool:'forks'`, `fileParallelism:false`,
  `?connection_limit=20&pool_timeout=30`. vitest `@` alias needs `fileURLToPath`
  (iCloud path has spaces → `%20` breaks `new URL().pathname`); fixed centrally on
  main, and D's tested files use relative imports as belt-and-suspenders.

## Test coverage

234 tests (unit + contract + behavioral smokes) across 28 files. `tsc --noEmit`
clean. Per-dir **≥85% line + branch** floor met on every target dir across **both**
providers at the last full `vitest run --coverage` (Gate 3): email ~96.5 / ~85.8,
oauth ~95.7 / ~85.6, sequences ~96.1 / ~89.6, sms ~92.2 / ~90.3, templates
~96.0 / ~89.5, clients ~96.2 / ~89.7 (line / branch). `jobs/` excluded (infra,
`worker:smoke`-covered). Two behavioral smokes:

- `pnpm gate1:smoke` — four acceptance paths against mocks + DB: (1) email send →
  provider mock → `status:'sent'`; (2) inbound STOP → `POST /dnc/internal` 201 →
  phone blocked; (3) Gmail delta → thread reconstructed → `crm_message` NOTIFY;
  (4) Graph delta → thread reconstructed → `crm_message` NOTIFY.
- `pnpm worker:smoke` — pg-boss worker consumes a queued `send-email`, AND the
  enrollment → tick → enqueue → worker → sent chain fires.

All re-verified at the rebase (runbook step 3).

## Notes for the merge

- **Migration baseline is owed AT the rebase, not before it.** D's only schema delta
  vs A's frozen `initial` is the 5 additive `OAuthCredential` columns; A's `initial`
  already creates every D-owned table + `Message.providerDeliveryState`. So, as the
  **first** step of the PR #4 rebase (after A + C + B are on main and their
  migrations are recorded on the shared DB):
  1. `prisma migrate dev --create-only --name oauth_credential_add_sync_state`
     → generates a single `ALTER TABLE "OAuthCredential" ADD COLUMN emailAddress …,
     gmailHistoryId …, graphDeltaLink …, gmailWatchExpiresAt …, status …`,
     timestamped **after** A's migrations (same play as C's `BulkScrubCheckpoint`
     reshape and B's S1/S2).
  2. `prisma migrate resolve --applied <ts>_oauth_credential_add_sync_state` — the
     shared dev DB already has these columns from the earlier `db push`, so **resolve
     marks the migration applied without re-running the ALTER** (which would fail:
     columns exist). On a fresh PROD DB, `migrate deploy` runs the ALTER normally.
  3. `prisma migrate status` → up to date, no drift.
  - **Why not during standby:** with no migrations dir in the worktree until the
    rebase, `migrate dev` now would diff the full schema against an empty history →
    a whole-fleet init migration owned by D + drift detection against the shared
    Railway DB (reset risk). Deferring keeps it a clean 5-column delta on A's baseline.
- `SMS_ENABLED=false` in the prod `.env`; flip only after 10DLC clearance.
- **Graph `internetMessageId` live-acceptance** owed post-Azure-cred (handoff §
  "Integration acceptance steps") — create a draft with a pre-set
  `internetMessageId`, send, verify Graph honored it (no dedup collision on retry).
- Converge the SMS-path compliance fail-closed reason to C's granular `REASON_CODES`.
- **Deferred live verification (owed by Ryan, env drop-in, no code change):** Google
  Cloud (`GOOGLE_CLIENT_ID/SECRET`) + Azure (`MSFT_GRAPH_CLIENT_ID/SECRET`) creds →
  `.env` for a real Gmail/Graph OAuth round-trip; Twilio 10DLC SIDs to un-park SMS.

## Ready to merge

Rebased on merged `main` (post A + C + B). **Fourth + last in dependency order
(A → C → B → D).** Composed boot available via `pnpm run boot:all` (health matrix
across all four slices).
