# Agent E — M0 Audit + Surface Map

**Branch:** `agent-e` (worktree `worktrees/agent-e`, forked from `origin/main` @ `659501e`)
**Date:** 2026-08-29
**Status:** M0 complete. M0.5 shipped — see §8 for what changed. M1 unblocked.

---

## §0 · BASELINE GATE RESULT — RED (pre-existing, stop per brief §2)

| Gate | Result |
|---|---|
| `pnpm install` | ✅ clean |
| `pnpm prisma:generate` | ✅ clean |
| `pnpm build` | ✅ **green** — compiled 15.4s, 22/22 static pages, `BUILD_EXIT=0` |
| `pnpm dev` | ✅ Ready in 213ms; `/` → 307 → `/leads` → HTTP 200 against live Railway DB |
| `pnpm test` | ❌ **RED — 10 failed / 750 tests, 5 failed / 120 files** |

Brief §2: *"If ANY of the above fail on a fresh worktree, STOP. That is a pre-existing
integration issue, not yours to fix."* This is that stop.

It matters beyond M0: brief §14 makes `pnpm test` green a **per-PR** gate, so a red
baseline blocks every PR from M1 onward, not just this one.

### Failing files (all Agent D, `src/lib/comms/**`)

```
src/lib/comms/email/gmail-adapter.test.ts   (12 tests | 1 failed)
src/lib/comms/email/graph-adapter.test.ts   ( 5 tests | 2 failed)
src/lib/comms/oauth/crypto.test.ts          (12 tests | 1 failed)
src/lib/comms/oauth/gmail.test.ts           ( 2 tests | 2 failed)
src/lib/comms/oauth/store.test.ts           ( 5 tests | 4 failed)
```

### Root cause — TWO config interactions, ZERO product-code bugs

Diagnostic runs:

| Run | Result |
|---|---|
| Full suite, `vitest.config.ts` (shared) | 10 failed / 750 |
| Full D suite, `vitest.agent-d.config.ts` | ✅ **226 passed / 226 (28 files)** |
| The 5 failing files, shared config | 7 failed / 36 |
| The 5 failing files, shared config **+ `--isolate`** | **1 failed / 36** |

**Cause 1 — `isolate: false` mock leak (9 of 10 failures).**
D's comms tests are fully mocked (`vi.mock` on prisma, fetch stubs) and were only ever
verified under `vitest.agent-d.config.ts`, which uses vitest's **default isolation (on)**
and omits `globalSetup`. The shared `vitest.config.ts` sets `isolate: false` — a
deliberate A/B/C fleet learning that protects the single shared Railway connection pool.
Under one shared module registry, D's per-file module mocks bleed across files. Proof:
the same 5 files pass 4/5 with `--isolate`, and the failure *set* changes with file
order (`gmail-adapter` and `oauth/gmail` fail in the full run but pass in the 5-file run).

**Cause 2 — env leak via `globalSetup` dotenv (1 of 10 failures).**
`src/lib/comms/oauth/crypto.test.ts` → *"throws when the key is missing"* asserts
`loadEncryptionKey(undefined)` throws. But the function signature is a **default
parameter**:

```ts
// src/lib/comms/oauth/crypto.ts:29
export function loadEncryptionKey(
  raw: string | undefined = process.env.OAUTH_TOKEN_ENCRYPTION_KEY,
): Buffer
```

Passing `undefined` *triggers the default*, so it reads the env var. The shared config's
`tests/setup/globalSetup.ts` starts with `import "dotenv/config"`, which loads `.env`
where `OAUTH_TOKEN_ENCRYPTION_KEY` is set (44 chars) — so it does not throw. D's own
config has no `globalSetup`, hence no dotenv, hence the env var is absent and it passes.
This failure survives `--isolate`; it is order-independent and purely env-dependent.

### Recommended fixes (planner's call — Agent E has NOT touched any of this)

- **Cause 1, Option A (recommended):** exclude `src/lib/comms/**/*.test.ts` from
  `vitest.config.ts` and run D's suite via its own config, chaining both in the `test`
  script (`vitest run && vitest run --config vitest.agent-d.config.ts`). Preserves the
  A/B/C pool protection *and* D's isolation. Lowest blast radius.
- **Cause 1, Option B:** set `isolate: true` globally. Risks re-opening the Railway
  connection pile-up the comment in `vitest.config.ts` explicitly warns about. Not
  recommended.
- **Cause 2:** one-line test fix — assert against a cleared env
  (`vi.stubEnv('OAUTH_TOKEN_ENCRYPTION_KEY', '')`) instead of relying on ambient absence.

All three are edits to **Agent D's** test surface / the shared config → brief §13 trigger
*"You find a bug in a prior slice that blocks a milestone."* Awaiting sign-off.

---

## §1 · API SURFACE INVENTORY

62 route files under `src/app/api/**`. Grouped by owning slice.

### Core Data — Agent A
| Path | Methods |
|---|---|
| `/api/leads` | GET (cursor + `limit`, max 200), POST |
| `/api/leads/[id]` | GET, PUT, DELETE |
| `/api/leads/[id]/activities` | GET |
| `/api/leads/[id]/custom-values` | GET, PUT |
| `/api/contacts` | GET, POST |
| `/api/contacts/[id]` | GET, PUT, DELETE |
| `/api/opportunities` | GET, POST |
| `/api/opportunities/[id]` | GET, PUT, DELETE |
| `/api/tasks` | GET, POST |
| `/api/tasks/[id]` | GET, PUT, DELETE |
| `/api/activities` | GET, POST |
| `/api/custom-fields` | GET, POST |
| `/api/custom-fields/[id]` | PUT, DELETE |
| `/api/smart-views` | GET, POST |
| `/api/smart-views/[id]` | GET, PUT, DELETE |
| `/api/data/search` | POST — Close-style `s_query` DSL + `sort` + opaque offset cursor |
| `/api/queue` | GET |
| `/api/imports` | POST |
| `/api/imports/[id]` | GET |
| `/api/imports/[id]/proposed-mapping` | POST |
| `/api/imports/[id]/commit` | POST |
| `/api/core-data/health` | GET |

### Telephony — Agent B
| Path | Methods |
|---|---|
| `/api/telephony/dial-sessions` | POST |
| `/api/telephony/calls/token` | POST |
| `/api/telephony/calls/[id]/ammunition` | GET |
| `/api/telephony/calls/[id]/recording` | GET |
| `/api/telephony/stream` | GET — **SSE**, pg `LISTEN crm_call` |
| `/api/telephony/pacing/status` | GET |
| `/api/telephony/pacing/resume` | POST |
| `/api/telephony/voice/conference` | POST |
| `/api/telephony/webhook/{voice,status,recording}` | POST |
| `/api/telephony/health` | GET |

### Compliance — Agent C
| Path | Methods |
|---|---|
| `/api/compliance/callable-now` | POST |
| `/api/compliance/scrub` | POST |
| `/api/compliance/dnc/internal` | POST |
| `/api/compliance/dnc/suppressions` | GET |
| `/api/compliance/policy/status` | GET |
| `/api/compliance/policy/confirm` | POST |
| `/api/compliance/circuit/resume` | POST |
| `/api/compliance/health` | GET |

### Communications — Agent D
| Path | Methods |
|---|---|
| `/api/comms/messages` | **POST only** — sends email *or* SMS (`channel` discriminant) |
| `/api/comms/sequences` | GET, POST (steps creatable inline here) |
| `/api/comms/sequences/[id]` | GET, PATCH, DELETE |
| `/api/comms/sequences/[id]/steps` | **GET only** |
| `/api/comms/templates` | GET, POST |
| `/api/comms/templates/[id]` | GET, PATCH, DELETE |
| `/api/comms/enrollments` | POST |
| `/api/comms/enrollments/[id]` | PATCH (`status`: paused/active/cancelled) |
| `/api/comms/oauth/{gmail,msft}/authorize` | GET |
| `/api/comms/oauth/{gmail,msft}/callback` | GET |
| `/api/comms/webhook/{gmail-push,sms}` | POST |
| `/api/comms/health` | GET |

### Cron
`/api/cron/{dealflow-signal-sync, dnc-refresh, gmail-sync, graph-sync, holiday-refresh, sequences-tick}` — all GET.

---

## §2 · EXISTING PAGE INVENTORY

Only **8** page files exist. Total UI surface today is ~536 lines including the dialer.

| Route | Lines | State | Notes |
|---|---|---|---|
| `/` | 5 | stub | `redirect('/leads')`. M2 replaces with Focus view. |
| `/leads` | 62 | partial | RSC, direct Prisma, `take: 100`. Table: name/status/priority/contacts/source. No search, filter, sort, selection, or pagination. Mounts `<Nav />`. |
| `/leads/[id]` | 93 | partial | Detail page exists. |
| `/dialer` | 10 | complete (B) | Thin wrapper over `<DialerShell />`. **Does not mount `<Nav />`.** |
| `/queue` | 85 | complete (A) | Smart-View chips + ranked queue + exclusion counts. Mounts `<Nav />`. |
| `/imports` | 70 | complete (A) | Upload entry. Mounts `<Nav />`. |
| `/imports/[id]/mapping-review` | 107 | complete (A) | Column-mapping review. |
| `/imports/[id]/progress` | 63 | complete (A) | Commit progress. |

**Routes that do not exist yet:** `/inbox`, `/sequences`, `/sequences/[id]`,
`/sequences/new`, `/templates`, `/snippets`, `/settings` (+5 sub-pages), `/reports`,
`/_dev/primitives`.

`src/app/layout.tsx` is 19 lines: `<html><body>{children}</body></html>` + metadata.
No shell, no theme, no providers. `src/app/globals.css` is 12 lines:
`@import "tailwindcss"` + two color vars. Tailwind v4, CSS-first config — no
`tailwind.config.ts`.

---

## §3 · API GAP LIST (brief §12 planner-call items)

### GAP 1 — Sequence step mutation · **blocks M4**
Steps can be created **only** at sequence-creation time. There is no way to add, edit,
reorder, or delete a step on an existing sequence.

`sequenceInputSchema` *does* accept `steps`, and `PATCH /api/comms/sequences/[id]` parses
it via `.partial()` — but `updateSequence()` then builds its `data` object from only
`name`/`description`/`channel`/`blackoutDates` and **silently drops `steps`**
(`src/lib/comms/sequences/crud.ts:81-89`). The request succeeds and returns 200 while
doing nothing. Silent no-op, not a 400.

*Minimal fix:* implement steps inside `updateSequence` (replace-all in a transaction), or
add POST/PATCH/DELETE to `/api/comms/sequences/[id]/steps`.
*Blast radius:* `src/lib/comms/sequences/crud.ts` + one route file; `crud.test.ts` covers
the function.

### GAP 2 — Snippets: no model, no routes · **blocks M4 item 7**
`grep -rniE '\bsnippet' src/ prisma/` → **zero hits**. Requires a new Prisma model *and*
new API routes — two §13 triggers.
*Options:* (a) approve `Snippet` model + CRUD routes; (b) drop snippets from M4 and
re-scope to a later brief. Planner's call — Agent E has no preference.

### GAP 3 — Message read/archive state · **blocks M3 + the §7 sidebar unread badge**
`Message` has **no** `readAt`/`isRead` and **no** archive flag. Its `status` column is
*delivery* state (`outbox`/`scheduled`/`sent`) owned by D's send pipeline — overloading it
for user-facing read/archive would corrupt outbound sending.

M3 requires unread-bolding and `e` to archive ("soft — sets a status flag"); §7 requires
`Inbox` badge = unread count. Neither has anywhere to live.

*Minimal fix:* two nullable columns — `readAt DateTime?`, `archivedAt DateTime?` — plus a
`PATCH /api/comms/messages/[id]`. Additive, nullable, zero backfill, no read-path change
for D.

### GAP 4 — OAuth disconnect/revoke · **blocks M5 "Disconnect" button**
No revoke route exists (`grep -rniE 'revoke|disconnect' src/` hits only
`telephony/softphone/controller.ts` and `core-data/events/listen.ts`, both unrelated).
`OAuthCredential.status` exists (`active|reauth_required|error`) but nothing exposes a
write to it.
*Minimal fix:* `DELETE /api/comms/oauth/[provider]`.

### Resolved WITHOUT amendment (recorded so the planner need not adjudicate)
- **Leads search / sort / filter (M1)** — `/api/leads` GET has only `limit` + `cursor`,
  but the page is an RSC reading Prisma directly, which brief §12 explicitly permits for
  reads. Smart Views come from `POST /api/data/search`.
- **Inbox thread reads (M3)** — `/api/comms/messages` is POST-only, but reads go direct
  via Prisma in an RSC. Group by `Message.threadId` → `EmailThread`.
- **Enrollment stats (M4)** — no GET on `/enrollments`; RSC + Prisma read.
- **Usage panel (M5)** — `monthlyCapStatus(prisma)` in
  `src/lib/telephony/cost/monthlyCap.ts`, callable from an RSC.
- **Tasks (M2)** — full CRUD already exists; see §5 correction.
- **DealFlow signals (M2)** — see §5 correction.
- **Softphone party name (M2)** — `GET /api/telephony/calls/[id]/ammunition` returns
  `lead.displayName`, `contact.displayName`, `derivedSignal.*`.

---

## §4 · COMPONENT REUSE AUDIT

`src/components/` contains exactly **one** file.

| Component | Verdict |
|---|---|
| `src/components/Nav.tsx` (22 lines) | Minimal top nav, `max-w-5xl`, 3 links (Leads/Queue/Import). Mounted per-page by `/leads`, `/queue`, `/imports` — **not** by `layout.tsx`, and **not** by `/dialer`. Superseded by the M1 shell; removal means deleting 3 per-page `<Nav />` mounts. |
| `src/app/dialer/components/DialerShell.tsx` | **Reuse as-is.** Owns the `EventSource("/api/telephony/stream")` subscription and dispatches on `evt.type`. Reference implementation for `useSoftphoneSession`. |
| `src/app/dialer/components/Softphone.tsx` | **Reuse as-is.** `<Softphone activeCallId={string \| null} />`, wraps `SoftphoneController`, owns mute/hangup. Brief §1.9 said "build one if it does not exist" — it exists. |
| `src/app/dialer/components/SessionControls.tsx` | Reuse as-is (B). |
| `src/app/dialer/components/AmmunitionPanel.tsx` | Reuse as-is (B). |

There is **no** design system, no primitives, no theme layer, no icon set. M1 is genuinely
greenfield: zero primitives to inherit, and correspondingly zero rework risk under §9.

---

## §5 · BRIEF CORRECTIONS (fact-checked against `origin/main` @ `659501e`)

1. **SSE path.** §7 says `/api/dial-session/stream`. Actual: **`GET /api/telephony/stream`**
   (pg `LISTEN` on channel `crm_call`).
2. **Wire vocabulary is narrower than §7 assumes.** The channel carries only
   `call.connected` (`callId`, `connectedAt`), `call.completed` (`callId`, `disposition`,
   `cost` as decimal-string), and `dial-session.pacing-update`. §7's four-state bar
   (connecting/ringing/talking/wrapup) is **not** on the wire — only connected/completed
   are. Agent E will render those two plus a client-side timer, and fetch party name +
   ammunition from `/api/telephony/calls/[id]/ammunition`. Flagging rather than requesting
   a wire change, since §13 warns that renaming/extending wire fields needs a cross-slice
   grep.
3. **Task model EXISTS.** §8 M2 says "empty state OK for MVP — no task model yet".
   Wrong: `Task` (dueDate, isComplete, isDateless, assignedToId, type, text) plus
   `/api/tasks` GET/POST and `/api/tasks/[id]` GET/PUT/DELETE are live. M2's "Tasks due"
   panel can be **real**, not an EmptyState.
4. **Sequence step types.** §8 M4 says "Step types D supports: email, wait, condition."
   Actual `stepInputSchema` = `{ ordinal, delayHours, channel: 'email'|'sms', templateId }`.
   *Wait* is expressed as `delayHours` **on** a step, not as a step type. **There is no
   condition support at all.** M4's editor should be scoped to email/sms + delay unless
   the planner wants conditions added (that would be a §13 model change).
   Note `templateId` is **required** on every step — a step cannot exist without a template.
5. **DealFlow signals need no cross-DB read.** §8 M2 proposes querying
   `DATABASE_URL_DEALFLOW_RO`. Unnecessary: `DealFlowDerivedSignal` is already mirrored
   into the CRM's own DB by `/api/cron/dealflow-signal-sync` (`mojoId`, `queueRank`,
   `priorityScore`, `queueReason`, `primaryMatchFit`, `primaryCaptureStatus`,
   `dealflowRawJson`). Agent E will read the **local** table — simpler, no second pool, and
   it keeps the read-only cross-DB credential unused at runtime. (`DATABASE_URL_DEALFLOW_RO`
   *is* populated in `.env`, 91 chars, if the planner prefers the direct join.)
6. **`OAuthCredential` has no `lastSyncAt`.** M5 wants "last sync time". Agent E will
   display `updatedAt` as the proxy and label it honestly ("last updated"), rather than
   request a column.
7. **Stale comment.** `tests/setup/globalSetup.ts` states *".env ships that var
   [DATABASE_URL_MAIN] EMPTY"*. It is set (132 chars) in the composed `.env`, and `/leads`
   serves HTTP 200 off it. Comment only — no behavior impact.

---

## §6 · TEST-INFRA CONFIRMATION (brief §10)

`vitest.config.ts` **already satisfies §10's intent**; no change made or needed.

| §10 requirement | Actual | Verdict |
|---|---|---|
| `fileParallelism: false` | present | ✅ |
| `isolate: false` | present | ✅ (but see §0 — this is what breaks D) |
| `poolOptions.forks.singleFork: true` | **absent**; uses `pool: 'forks'` + `maxWorkers: 1` + `minWorkers: 1` | ✅ equivalent — single fork, one Prisma pool |
| `fileURLToPath(new URL(...))` alias | present, with an explicit iCloud percent-encoding comment | ✅ |

**Recommendation: do not add `singleFork` and do not flip `isolate`.** The existing
settings achieve single-process execution, and the file's comments document a deliberate
Railway connection-pool defense. The §0 fix should scope D's tests out of this config
rather than change these values.

Also present: `vitest.agent-c.config.ts`, `vitest.agent-d.config.ts`,
`playwright.config.ts`, and one existing e2e spec (`tests/e2e/importer-happy-path.spec.ts`)
— so M1's Playwright smokes extend an existing harness rather than creating one.

Two pre-existing build warnings (not introduced by Agent E, not fixed by Agent E):
multiple-lockfile workspace-root inference, and Next 16's `middleware` → `proxy`
deprecation.

---

## §7 · READINESS

| Milestone | Ready? | Blocker |
|---|---|---|
| M1 shell + primitives + leads | ✅ data-ready | §0 test gate only |
| M2 Focus + softphone bar | ✅ data-ready | §0; §5.2 narrows bar states |
| M3 Inbox | ❌ | **GAP 3** (read/archive state) |
| M4 Sequences + Templates | ⚠️ partial | **GAP 1** (step editing); templates fine |
| M4 Snippets | ❌ | **GAP 2** (no model at all) |
| M5 Settings | ⚠️ partial | **GAP 4** (disconnect); rest fine |
| M6 Imports polish | ✅ | none |

**Agent E has written no application code and made no dependency, schema, or config
changes.** The worktree contains this document only.

---

## §8 · M0.5 RESOLUTION LOG (planner-approved, 2026-08-29)

Planner reviewed this audit and approved a single pre-M1 PR. What changed:

| Item | Resolution |
|---|---|
| **Blocker 1** (red baseline) | `vitest.config.ts` now excludes `src/lib/comms/**`; `package.json` `test` chains `vitest run && vitest run --config vitest.agent-d.config.ts`. `isolate` NOT flipped. |
| **GAP 1** (sequence steps) | `updateSequence()` now persists `steps`. Implemented as an **ordinal reconcile**, not delete-and-recreate — see the deviation note below. `PATCH /api/comms/sequences/[id]` returns **409 `sequence_step_in_use`** when a removal would strand an active enrollment. |
| **GAP 2** (snippets) | **CUT.** Removed from §1 mission item 7 and M4 acceptance. Templates cover the use case; Ryan does not use snippets in Close. No model, no routes, no UI. Fast-follow if missed post-M6. |
| **GAP 3** (message state) | `Message.readAt` + `Message.archivedAt` (`TIMESTAMPTZ(6)`, nullable). Migration `20260829140409_message_read_archive_state`, additive, applied to Railway. New `PATCH /api/comms/messages/[id]` and `GET /api/comms/messages/unread-count`. |
| **GAP 4** (OAuth disconnect) | New `POST /api/oauth/[provider]/revoke` (`gmail` \| `outlook`) + `markRevoked()` in D's store + RFC 7009 `revokeToken()` in `oauth/gmail.ts`. |

### Deviations from the planner's literal instruction (all deliberate)

1. **GAP 1 is a reconcile, not a replace-all.** `SequenceEnrollment.currentStepId` is a
   plain `String` with **no FK**, and `tick.ts:59` **throws**
   (`current step <id> not found in sequence <id>`) when it cannot resolve that id.
   Delete-and-recreate mints new step ids and would break every active enrollment on the
   next tick. Instead: existing steps (ordinal-sorted) are matched positionally to the
   incoming list — overlap is `UPDATE`d **in place** (ids preserved), the tail is deleted,
   extras are created. Dropping a step an active enrollment sits on throws
   `SequenceStepInUseError` → 409, mirroring the existing `TemplateInUseError` → 409 idiom
   in `templates/crud.ts`.
2. **`unread-count` also filters `direction: 'incoming'`.** The planner's sketch was
   `{ readAt: null, archivedAt: null }`. Without the direction filter every message Ryan
   *sends* counts as unread and the badge is useless within a day of dialing.
3. **Outlook revocation is local-only.** AAD v2 exposes no RFC 7009 endpoint; Graph's
   `POST /me/revokeSignInSessions` needs a scope this app does not hold (D requests
   `offline_access, Mail.Read, Mail.Send, User.Read`). Gmail gets a real remote revoke;
   Outlook drops tokens locally and the response reports `remoteRevocation: false` rather
   than implying a remote revoke happened.
4. **`accessTokenEncrypted` is emptied, not nulled.** The column is `NOT NULL` in the
   frozen schema and the planner did not approve making it nullable. `''` is stored;
   decrypting it throws, which is correct fail-closed behaviour for a dead credential.
5. **Revoke route path.** Placed at `/api/oauth/[provider]/revoke` exactly as the planner
   specified. Note this sits **outside** the `/api/comms/oauth/**` namespace where every
   other OAuth route lives (`authorize`, `callback`). Flagging the inconsistency; not
   changing it unilaterally.
6. **`TIMESTAMPTZ(6)` vs the rest of `Message`.** Every other `DateTime` on `Message` maps
   to Prisma's default `timestamp(3)` (no time zone). The two new columns are
   `timestamptz(6)` per explicit instruction. Better type, but the table is now mixed.

### NEW FINDING — pre-existing schema/migration drift (NOT Agent E's, NOT fixed)

`prisma migrate status` reports "up to date", but that only compares *applied* migrations
against the migrations folder. `prisma migrate diff --from-migrations --to-schema-datamodel`
reveals `prisma/schema.prisma` has changes that **no migration has ever applied**:

- **`BulkScrubCheckpoint` reshape (Agent C) — DESTRUCTIVE.**
  `DROP COLUMN "lastProcessedPhone"`, `DROP COLUMN "startedAt"`,
  `ADD COLUMN "chunkIndex" | "haltReason" | "lastProcessedContactPhoneId"`,
  `ALTER COLUMN "importBatchId" SET NOT NULL`, plus two new indexes (one **UNIQUE** on
  `[organizationId, importBatchId]`, which fails if duplicates exist).
- **Four unapplied `id` defaults** — `Call`, `CustomFieldDefinition`, `DialSession`,
  `SavedView` all want `DEFAULT 'prefix_' || substr(md5(random()::text), 1, 24)`.

This matches the known landmine that Agent C left two local-only commits (reshape
migration + doc) that never reached `main` — only the `schema.prisma` edit did.

**Consequence:** anyone who runs `prisma migrate dev` in this repo will silently fold
Agent C's destructive reshape into their own migration. Agent E's migration was
hand-written to contain **only** the two `Message` columns for exactly this reason.

**Recommendation:** planner should schedule a dedicated drift-reconciliation PR (likely
recovering C's local commits). Agent E has not touched it — it is destructive, it is C's,
and it is outside this brief.

---

## §9 · REPO GOTCHAS FOR THE NEXT EXECUTOR

Hard-won during M0/M0.5. Read before touching migrations or the test suite.

### 1. `DATABASE_URL_PERF` is NOT a safe `--shadow-database-url`

Prisma **drops and recreates** the shadow database to replay migration history
into it. Pointing `--shadow-database-url` at the perf DB destroys the 25k perf
seed and turns `tests/perf/25k.test.ts` red (`found 0 leads in org_perf`).

```bash
# ✗ DESTROYS the perf seed
npx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DATABASE_URL_PERF"

# ✓ Read-only: introspects the LIVE db, no shadow database at all.
#   Use this to answer "does the DB match schema.prisma?"
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script

# ✓ If you genuinely need --from-migrations (replaying history requires a
#   shadow), point it at a THROWAWAY database, never a seeded one.
#   e.g. postgresql://.../temp_shadow_$(date +%s)
```

Recovery if you do wipe it: `pnpm seed:perf` (~33s; 25k leads, 25k contacts,
33k phones, 50k custom values). Perf data is disposable by design — but a red
perf test will block your PR gate until you re-seed.

### 2. Never run `prisma migrate dev` in this repo

`schema.prisma` carries drift that no migration has applied — Agent C's
**destructive** `BulkScrubCheckpoint` reshape plus four unapplied `id` defaults
(see §8). `migrate dev` silently folds all of it into whatever migration you are
creating. `migrate status` will NOT warn you: it only compares applied migrations
against the migrations folder, never schema-to-DB.

**Instead:** hand-write `prisma/migrations/<timestamp>_<name>/migration.sql`
containing only your own delta, then `npx prisma migrate deploy` and
`npx prisma generate`. This is how `20260829140409_message_read_archive_state`
was produced.

C's drift is queued for Ryan's post-M6 cleanup PR. **Do not touch it.**

### 3. `pnpm test` runs two configs and fails fast

`"test": "vitest run && vitest run --config vitest.agent-d.config.ts"`. The `&&`
short-circuits, so a failure in the first (A/B/C) config means Agent D's suite
never runs and you see nothing about it. That is intended — fail-fast beats
scrolling. To see D's results while A/B/C are red, run it directly:

```bash
pnpm vitest run --config vitest.agent-d.config.ts
```

Do **not** move D's tests back into `vitest.config.ts`; its `isolate: false`
(the shared-Railway-pool defense) breaks D's `vi.mock`-based files. See §0.

### 4. `next-env.d.ts` churns between `next dev` and `next build`

It rewrites itself between `./.next/dev/types/routes.d.ts` and
`./.next/types/routes.d.ts` depending on which ran last. It is machine-generated
("should not be edited") — leave it at whatever `HEAD` has and keep it out of
your commits (`git restore next-env.d.ts`).

### 5. `gh` CLI is not installed on this machine

The `~/.config/gh/hosts.yml` exists but holds no token and the binary is absent.
Open PRs against the GitHub API using the token from the git credential helper:

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill \
  | sed -n 's/^password=//p')
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/Ram5268/dealflow-crm/pulls -d @pr.json
```

### 9.6 — iCloud duplicates images too, and a dupe can hold pre-redaction content

`.gitignore` guarded `* 2.ts/tsx/md` but not images. After overwriting a Close
capture with a redacted version, iCloud resurrected the ORIGINAL as
`reference/close/leads 2.png` — still holding live client emails and phone
numbers, staged for commit. Deleted, and `**/* 2.{png,jpg,jpeg,webp}` added to
`.gitignore`.

**Rule:** after replacing any committed binary in this repo, run
`find . -name "* 2.*" -not -path "./node_modules/*"` before staging.

### 9.7 — `xattr` fileprovider ignore does NOT solve iCloud node_modules stalls

**Symptom:** `tsc --noEmit` hangs — 8m17s wall for 6.88s of CPU (1%), while
`fileproviderd` sits at 98%. `next build` hangs past 10 minutes on the
"Running TypeScript" phase. Began right after installing 51 packages.

**Attempted fix that did NOT work:**
`xattr -w 'com.apple.fileprovider.ignore#P' 1 node_modules .next`. The attribute
applied and read back as `1`, and the stall continued unchanged. (The planner's
note cites `com.apple.fileprovider.exclude`; the attribute actually used here was
`com.apple.fileprovider.ignore#P` — neither helped.) The macOS file provider
still materializes on read.

**Working fix — mirror the worktree outside iCloud and run every gate there:**

```bash
rsync -a --delete --exclude node_modules --exclude .next --exclude .git \
  --exclude 'coverage*' --exclude 'reference/dealflow' \
  "worktrees/agent-e/" ~/dev/agent-e-gates/
cd ~/dev/agent-e-gates && pnpm install --prefer-offline && npx prisma generate
```

Measured: typecheck **8m17s → 7s**, build **>10min → 19s**. ~67x.
`scripts/gate.sh` wraps the rsync + gate invocation.

Commit and push from the iCloud worktree as normal — git itself is fast enough.
Moving the whole repo out of iCloud is the long-term fix (post-M6, Ryan's call).

**Diagnostic:** a process at ~0% CPU in state `S` while `fileproviderd` is hot is
iCloud, not the tool. `ps -o pid,etime,%cpu,state -p <pid>`.

---

## §10 · M2 DEVIATIONS AND FINDINGS (2026-08-29)

Planner rule in force: *"reality wins, note the deviation in your PR description."*
Each item below is either a deliberate departure from the literal instruction or
something found while building that the planner should know about.

### 10.1 — Top-bar search is a BUTTON, not an `<input>` · deviation

The parity call said "Input primitive that opens ⌘K on focus." An `<input>`
cannot do that without looping: Radix restores focus to the previously focused
element when the dialog closes, so focus lands back on the input, the `focus`
handler fires again, and the palette reopens forever.

`SearchLauncher` is therefore a `<button>` styled with the same `controlBase` /
`controlBorder` classes as `Input`, so it is pixel-wise an input. Keyboard users
get correct Enter/Space semantics and a real accessible name. An e2e case
asserts the palette stays closed 300ms after Esc, which is the regression this
would produce.

### 10.2 — There are now TWO "Search ⌘K" controls · **planner decision wanted**

M1 already shipped a `Search ⌘K` row at the bottom of the sidebar nav
(`Sidebar.tsx`), because search is an action rather than a destination. The M2
top-bar launcher is a second control that opens the same palette, and both are
visible at once (see `reference/dealflow/focus-home.png`).

Not removed, because deleting working M1 chrome is rework under §9. Close's own
IA puts search in the top bar only. **Ask:** keep both, or drop the sidebar row?
One-line change either way.

### 10.3 — Focus reads through Prisma in RSC · no new API routes

§13 forbids new API routes. `src/lib/focus/summary.ts` is a server-only module
imported by Server Components, mirroring the boundary convention
`src/lib/leads/list.ts` established in M1. Zero routes added in M2.

### 10.4 — Dial-queue count reuses `getQueue` at /queue's own limit

The panel calls `getQueue(view, org, { limit: 50 })` — the identical call
`/queue` already makes — so the two surfaces can never disagree. That runs an
unconditional compliance scrub over a candidate pool 5x the limit, which is why
each panel sits behind its own `<Suspense>` boundary instead of blocking the
page on the slowest read.

When compliance cannot answer, the panel says *"Could not verify who is callable
right now"* rather than rendering `0`. A bare zero reads as "nobody to call",
which is a different and dangerous claim. Compliance is fail-closed upstream and
the UI now matches that posture.

### 10.5 — Softphone "Hang up" replaced with "Open dialer"

M1's bar carried an inert `Hang up` button. Wiring it for real means dial
control, which §13 forbids. A visible control that does nothing is worse than no
control, so the bar is now status-only and links to `/dialer`, where Agent B's
real controls live. The bar renders `role="status" aria-live="polite"`.

### 10.6 — FOUND, NOT FIXED: `DialerShell` never clears its active call

`src/app/dialer/components/DialerShell.tsx` subscribes with `useEffect(…, [])`
but compares `evt.callId === activeCallId` inside the handler. That closure
captured `activeCallId` at mount, so it is `null` forever and the
`call.completed` branch can never match. The ammunition panel therefore keeps
showing a finished call until something else re-renders.

**Not fixed** — dialer logic is out of scope (§13). Flagging for the planner to
schedule. `useSoftphoneSession` deliberately avoids the same bug by using a
functional `setSession` updater, with a comment naming the trap.

### 10.7 — Nested `<main>` landmarks fixed on /dialer and /queue

`AppShell` already renders the `<main>` landmark, so both pages were emitting a
second one inside it — invalid HTML and a duplicated landmark for screen
readers. Both now render a plain container. `/dialer` also dropped its `<h1>`,
which duplicated the title `TopBar` already shows.

`/imports/*` has the same nested-`<main>` bug in three files. Left alone: it is
explicitly M6 scope.

### 10.8 — Hardcoded palette migrated to tokens on /dialer and /queue

Both surfaces used literal `bg-gray-*` / `text-neutral-*` / `bg-blue-50` classes
and were unreadable in dark mode. Pure class substitution onto the M1 tokens —
no structural or logic change. Verified zero remaining hardcoded palette classes
under `src/app/dialer` and `src/app/queue`.

### 10.9 — `gate.sh` uses `rsync --delete`, so mirror-only files evaporate

Anything written directly into `~/dev/agent-e-gates` is destroyed by the next
gate run. That is a feature — scratch scripts cannot leak into a commit — but it
means an acceptance-seed script has to be rewritten each time it is needed.
Write scratch tooling to the mirror on purpose, never to the worktree.

### 10.10 — iCloud duplicated a `.sh`, which the ignore list did not cover

`scripts/gate 2.sh` appeared as untracked and was ready to stage. The §9.6
patterns only covered `.ts/.tsx/.md` and images. `.gitignore` now also ignores
`* 2.sh`, `* 2.json`, `* 2.css`, `* 2.sql`, `* 2.mjs`. The two image dupes found
in the same sweep were byte-identical to their originals — no PII regression —
but **verify sizes before deleting**, never assume.

### 10.11 — Acceptance evidence used a seeded-then-deleted dataset

The main DB is empty (0 leads / calls / messages / tasks), so panels would have
rendered as all-zero. Following the M1 precedent, a small `[M2_SMOKE]` dataset
was created, captured, and deleted. Post-cleanup verification returned
`RESIDUE {leads:0,contacts:0,tasks:0,messages:0,calls:0,views:0}` and
`DB_TOTALS` back to all-zero — byte-identical to the pre-seed state. The seed
script lived only in the gate mirror and was never committed (see §10.9).
