# Agent E — M0 Audit + Surface Map

**Branch:** `agent-e` (worktree `worktrees/agent-e`, forked from `origin/main` @ `659501e`)
**Date:** 2026-08-29
**Status:** M0 complete. **M1 BLOCKED** — see §0.

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
