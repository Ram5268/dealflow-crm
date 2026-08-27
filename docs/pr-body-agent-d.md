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

Rebased on merged `main` (`88e992d`, post A + C + B). Gate 1 (isolation boot: app +
4 mocks) · Gate 3 (behavioral smokes + coverage floors, **both providers**). 226
comms unit tests green, `tsc --noEmit` clean, no iCloud ` 2.ts` duplicates, no `.env`
committed.

## Contract exposures (this slice)

- **Emits** (channel `crm_message`): `message.received`. **No `eventName`/`type`
  discriminant** on the wire — routing is `(channel, payload-shape)`, matching the
  fleet convention. Every NOTIFY is validated against the frozen `message.received`
  Zod schema before `pg_notify` (`events.ts`). (Grep-verified: zero
  `type: 'message.received'` in `src/`.)
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
  This is D's **entire** schema delta vs A's frozen baseline.
- **`Message.providerDeliveryState`** — **already in A's `initial`** migration
  (`20260827045415_initial`). No D migration needed; flagged for the spot-check.
- Every D-owned table (`Message`, `EmailThread`, `MessageTemplate`, `Sequence`,
  `SequenceStep`, `SequenceEnrollment`) is also already created by A's `initial`.

> **Baseline migration (done in this PR):** `git diff origin/main -- prisma/schema.prisma`
> is *exactly* the 5 `OAuthCredential` columns. So the post-rebase migration
> `20260827130000_oauth_credential_add_sync_state` is a single
> `ALTER TABLE "OAuthCredential" ADD COLUMN …` (verified), timestamped after all four
> upstream migrations (A `initial`+`add_notify_overflow`, B `call_add_composite_unique`+
> `call_source_default_flip`). Generated offline via `migrate diff`; recorded on the
> shared DB via `migrate resolve --applied` (columns already exist from the earlier
> `db push`, so the ALTER is not re-run). `migrate status` → up to date, no drift.

## Cross-slice notes

- **Both providers, one path.** `gmail-sync.ts` is provider-agnostic orchestration
  over `SyncPorts`; Gmail and Graph share reconstruction, dedup, and persist ports.
  Only the client + cursor differ (Gmail threadId/historyId, Graph
  conversationId/deltaLink). **Graph is REST/`fetch`, not the SDK** — same
  configurable-base-URL mockability as Twilio.
- **`internetMessageId` dedup — one live check owed.** Sent-mail dedup keys
  `providerMessageId` on a pre-set client-side id (Gmail: RFC5322 `Message-ID`;
  Graph: `internetMessageId` on the draft) so the Sent-folder re-sync short-circuits
  on the `@unique`. Graph honoring `internetMessageId`-on-draft is **assumed**;
  post-Azure-cred acceptance step + fallback documented in `docs/agent-d-handoff.md`.
- **REASON_CODES converged (done in this PR).** C's PR #2 dropped the coarse
  `vendor_error` and added the granular 19 + service-level `compliance_unavailable`.
  D's SMS-path compliance scrub now fail-closes with **`compliance_unavailable`** —
  the service-level code (same choice as A's compliance-bridge): when C itself is
  unreachable there is no per-vendor verdict to name. `src/lib/comms` is grep-clean
  of the dropped `vendor_error` value.
- **Compliance mock split at rebase.** A/C's canonical contract mock
  (`contracts/mocks/compliance/server.ts`, `createServer`/`computeResults`) is kept
  byte-identical; D's behavioral mock (the `/scrub` + `/dnc/internal` DNC-ledger the
  `gate1:smoke` needs, which the contract mock doesn't model) moved to
  `contracts/mocks/compliance/comms-mock.ts`. D's three scripts repoint there; the
  boot scripts stay on canonical.
- **SMS parked.** `SMS_ENABLED=false` until 10DLC clears; the flip is a runtime
  config change, not a code change. Gated three ways: `SMS_ENABLED` →
  `requireTwilioConfig` (fail-fast on missing 10DLC SIDs) → compliance scrub
  (fail-closed).
- **`jobs/` dir is coverage-exempt.** `boss.ts`, `gmail-runner.ts`, `graph-runner.ts`,
  `*-delta.ts` are pg-boss infra (the singleton resists mocking) — covered by
  `worker:smoke`, intentionally outside the comms coverage-floor set.
- **Test-infra posture inherited from main** (A/B's shared-Railway-DB stance):
  `globalSetup` pushes to `DATABASE_URL_PERF` with a URL guard; `pool:'forks'`,
  `isolate:false`, `fileParallelism:false`, `maxWorkers:1`; `@` alias via
  `fileURLToPath` (iCloud path spaces). D's comms unit suite is fully mocked (no live
  DB), so `vitest.agent-d.config.ts` runs it standalone (no globalSetup).

## Test coverage

226 comms unit tests across 28 files, all green; `tsc --noEmit` clean. Coverage
floors are CI-enforceable via **`vitest.agent-d.config.ts`** (`pnpm test:coverage:comms`,
mirrors `vitest.agent-c.config.ts`) — **≥85% lines + branches on every comms
product-surface dir**, `jobs/**` excluded:

| dir | lines | branches |
|---|---|---|
| clients | 100 | 89.7 |
| email | 98.0 | 85.8 |
| oauth | 95.3 | 85.6 |
| sequences | 96.7 | 89.6 |
| sms | 93.9 | 90.3 |
| templates | 98.8 | 89.5 |

Two behavioral smokes (`pnpm gate1:smoke`, `pnpm worker:smoke`) exercise: email
send → provider mock → `status:'sent'`; inbound STOP → `/dnc/internal` 201 → blocked;
Gmail + Graph delta → thread reconstructed → `crm_message` NOTIFY; and the
enrollment → tick → enqueue → worker → sent chain.

## Notes for the merge

- **Migration baseline is in this PR and already recorded on the shared DB.**
  `20260827130000_oauth_credential_add_sync_state` (5-column additive ALTER) was
  `migrate resolve --applied` against the shared dev DB (columns pre-exist from
  `db push`), so a post-merge `migrate deploy` is a no-op there and runs the ALTER
  normally on a fresh PROD DB. Sorts after all four upstream migrations.
- `SMS_ENABLED=false` in prod `.env`; flip only after 10DLC clearance.
- **Graph `internetMessageId` live-acceptance** owed post-Azure-cred (handoff §
  "Integration acceptance steps").
- **Deferred live verification (owed by Ryan, env drop-in, no code change):** Google
  Cloud + Azure creds → `.env` for a real Gmail/Graph OAuth round-trip; Twilio 10DLC
  SIDs to un-park SMS.

## Ready to merge

Rebased on merged `main` (`88e992d`, post A + C + B). **Fourth + last in dependency
order (A → C → B → D)** — this is the final slice; on merge the whole CRM is on main.
Composed boot available via `pnpm run boot:all` (health matrix across all four slices).
