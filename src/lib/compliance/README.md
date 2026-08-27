# Compliance slice (Agent C) — the legal fail-safe

Decides, for every phone the dialer wants to call, whether that call is legally
permitted **right now**. Every other slice defers to this before outbound
contact. **First rule: fail-closed.** Any error, timeout, missing config,
unconfirmed policy, ambiguous timezone, or unreachable vendor → `callable:false`.
Never a positive signal from a negative check.

**Milestone 1 (fail-closed core) is complete and shipped here.** Vendor
integrations (federal/state DNC, litigator, Twilio Lookup) are **Milestone 2**
and are **BLOCKED** on Ryan selecting vendors (`DNC_VENDOR` / `LITIGATOR_VENDOR`
unset). See "M2 blocked" below.

## Public surface

### HTTP (live in M1)
- `POST /api/compliance/callable-now` — hot path; called inline by Agent B before
  every dial. Body `{ contactPhoneIds: string[] (max 100), atInstant?: ISO }`.
  Response `{ results: [{ contactPhoneId, phone, callable, reasons[], reasonDetails? }] }`.
  Over 100 ids → **HTTP 413** `{ error:"batch_too_large", maxItems:100, receivedItems }`.
- `POST /api/compliance/dnc/internal` — add to internal DNC (Agent D on SMS STOP).
  Response `{ id, phone, source:"internal", addedAt, added }`. `added:false` = idempotent.
- `GET /api/compliance/dnc/suppressions?phone=E164` — read suppressions for a phone.
- `POST /api/compliance/policy/confirm` — Ryan confirms a CallingWindowConfig.
- `GET /api/compliance/policy/status` — configs + unconfirmed timezones.
- `POST /api/compliance/circuit/resume` — bearer `CRON_SECRET`; un-halt a vendor circuit.
- `GET /api/compliance/health` — DB latency, holiday staleness, vendor reachability, circuit state.
- `GET /api/cron/holiday-refresh` — bearer `CRON_SECRET`; nightly holiday upsert.

### HTTP (M2, vendor-blocked)
- `POST /api/compliance/scrub`, `GET /api/cron/dnc-refresh` — need a selected DNC vendor.

### Events emitted
- `scrub.completed` on channel `crm_scrub`: `{ phoneCount, blockedCount, checkedAt, correlationId }`.
  Emitted inside the same DB tx as the ScrubLog writes. No `eventName`/`type`
  discriminant — channel is the routing signal. Consumes nothing.

### Reason vocabulary
Single source of truth: `contracts/http/reason-codes.ts` (re-exported from
`src/lib/compliance/index.ts`). Adding/removing a code is a contract change —
route through the planner.

## Boot in isolation (Gate 1)

```bash
# With Doppler:
pnpm exec doppler run -- bash scripts/run-isolation-boot.sh
# Without Doppler (reads .env directly — must define DATABASE_URL_MAIN):
bash scripts/run-isolation-boot.sh
```
Needs `DATABASE_URL_MAIN` (Railway dev DB, or a local docker Postgres:
`docker compose up -d postgres` then point `DATABASE_URL_MAIN` at it). Runs the
iCloud sweep, `prisma migrate deploy`, seeds fixtures, boots `pnpm dev`, and
smokes `callable-now` at a controlled ET instant. M1 boots with NO vendor.

## Gotchas (repo-wide, learned the hard way)

- **vitest `@` alias + iCloud spaces.** The repo lives under a path with spaces
  (`Antigravity Projects/`). `new URL('./src', import.meta.url).pathname` leaves
  the spaces percent-encoded (`%20`), which breaks module resolution for every
  `@/...` import in tests. Fix (in `vitest.config.ts`): resolve the alias with
  `fileURLToPath(new URL('./src', import.meta.url))`, which decodes it. Agent B
  hit the same thing — if a new slice's tests fail with "Cannot find package
  '@/...'", this is why.
- **iCloud ` 2.ts` duplicates.** iCloud silently clones files as `foo 2.ts`,
  fooling grep and compiling stale copies. Sweep before every session; the boot
  script and CI both abort if any exist.

Automated gates (no DB): `pnpm exec vitest run --config vitest.agent-c.config.ts --coverage`.

## Fail-closed matrix (§11)

| Dependency | Failure | callable-now result |
|---|---|---|
| ContactPhone | row missing | `false, ["phone_missing"], phone:""` |
| Contact.timezone | null/empty | `false, ["timezone_unresolved"]` |
| IANA tz db | zone invalid | `false, ["timezone_invalid"]` |
| CallingWindowConfig | missing OR unconfirmed | `false, ["policy_unconfirmed"]` |
| Internal DNC | phone on list | `false, ["internal_dnc"]` |
| Calling window | outside hours / day | `false, ["outside_calling_window_hour"|"_day"]` |
| Holiday | federal / state | `false, ["holiday_federal"|"holiday_state"]` (+reasonDetails) |
| Holiday table | >40d stale | `false, ["holiday_table_stale"]` |
| DNC vendor (M2) | timeout/5xx/non-2xx/malformed | `false, ["vendor_error_dnc"]` |
| Litigator (M2) | any error | `false, ["vendor_error_litigator"]` |
| Circuit breaker | >20% errors / 5min | `false, ["circuit_open_dnc"|"circuit_open_litigator"]` |
| Twilio Lookup (M2) | any error | **advisory only** — never flips callable |
| Postgres | down | 500 → Agent B treats as fail-closed |
| Batch cap | >100 ids | HTTP 413 |

## Configuring a CallingWindowConfig (policy gate)

No timezone is dialable until Ryan confirms a policy for it (after conferring
with counsel). `POST /api/compliance/policy/confirm` with
`{ timezone, earliestHour, latestHour, allowedDaysOfWeek, policyConfirmedBy }`.
`policyConfirmedBy` is a structured attestation, min 20 chars
(`"user:<email>|counsel:<name>|date:<YYYY-MM-DD>"`). Defaults are
most-restrictive-safe: **weekdays only, 9am–8pm local**. Do not relax without
Ryan's sign-off. `GET /api/compliance/policy/status` lists unconfirmed timezones.

## Adding a state to holiday tracking

Add its 2-letter code to `TRACKED_STATES` in `holidays/stateHolidays.ts`; the
nightly `holiday-refresh` cron picks it up (federal + state-specific public
holidays via `date-holidays`). Never deletes past dates (audit trail).

## tzStateMap broadness (review before ship)

`timezone/tzStateMap.ts` maps IANA → US states for **holiday-scope resolution
only** (never the window check). Buckets are intentionally BROAD: when a
contact's address state is unknown, the holiday check expands to EVERY state in
the tz bucket and blocks if any has a holiday — deliberate **over-blocking**
(fail-closed). The `America/New_York` bucket includes Central-partial states
(KY, IN, MI, TN) on purpose. **Ryan: review and prune the buckets before ship.**
Single-state zones (America/Phoenix→AZ, Pacific/Honolulu→HI, America/Anchorage→AK,
America/Puerto_Rico→PR) resolve unambiguously.

## Cross-slice timezone semantics

Agents A/D may render a display-layer `America/New_York` for null-tz contacts,
but that fallback does NOT reach here — `callable-now` reads `Contact.timezone`
directly and fails-closed on null (`timezone_unresolved`). So a lead can appear
in `/api/queue` yet be blocked at dial. This is intentional.

## M2 blocked (vendor selection)

`DNC_VENDOR`, `DNC_API_KEY`, `LITIGATOR_VENDOR`, `LITIGATOR_API_KEY` are unset.
M2 (federal/state DNC read-through + refresh, litigator scrub, Twilio Lookup,
`scrub` endpoint, bulk-scrub worker, `dnc-refresh` cron) is blocked until Ryan
picks vendors. The `noop` vendor is a fail-closed sentinel (returns errored batch
→ `vendor_error_not_configured`), NOT a clean pass. Nightly full re-scrub of 25k
phones will cost vendor $ — project monthly cost once a vendor is chosen.
