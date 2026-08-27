# Integration Runbook v1.1 — Agent A review round 2

You invited a re-flag if anything in the fold was off. One item: **the M2 gate as
written assumes A can mechanically remap dropped coarse codes, but reading C's actual
19-code enum (`agent-c@fd3d28d`) shows there's no valid target for A's one hardcoded
code — and the mismatch is silent (no tsc guard).** Plus one piece of good news.

## Good news — the boot-crash risk is CLEARED
C's 19-code set **retains `timezone_unresolved`** (verified on `agent-c`). So A's
module-load assertion at `src/lib/shared/reason-codes.ts:16` does NOT throw when C's
file overwrites main at PR #2. The hard-crash scenario from M2 is off the table. The
superset gate is still worth keeping as a guard, but this specific code survives.

## The audit result (the M2 A-side gate you assigned me)
Grepped every reason-code string literal in A's `src/`. **Exactly one** coarse code is
hardcoded by A: `vendor_error`, at two sites, both in `compliance-bridge.ts`:
- **:129** — whole-batch failure: `caller(body)` threw (C unreachable / timeout / 5xx) →
  fail-closed every phone in the batch.
- **:143** — C returned but **omitted** a submitted phone id → fail-closed that phone.

Both mean **"A got no usable answer from the compliance service itself."** That is a
*connectivity/omission* failure. A cannot know which upstream vendor was involved —
it never received a response.

Everything else is clean: A references all other codes only via the enum/type, and A's
**consumer** path is already tolerant — `areReasonsKnown()` at :146 passes C's unknown
codes through as `callable:false`. So C **adding** codes never breaks A. The only
exposure is A's own **emission** of `vendor_error`.

## The gap: C's 19 has no code for "compliance service unreachable"
C split `vendor_error` into four **vendor-specific** variants:
`vendor_error_dnc`, `vendor_error_litigator`, `vendor_error_mobile_line`,
`vendor_error_not_configured` (+ `circuit_open_dnc/_litigator`). Every one names *which of
C's own upstream vendors failed* — a distinction only C can make, because only C got a
response. None describes "the compliance service as a whole gave no answer," which is
precisely A's fail-closed condition. The code that *would* have fit —
`compliance_unavailable` — is the one you noted C **dropped**.

So A's remap has no correct destination:
- `vendor_error_not_configured` is the nearest string but is **semantically wrong** — it
  asserts a config gap in C's vendor wiring, not a network failure reaching C. Using it
  pollutes exactly the granular TCPA audit trail C's split was designed to protect.
- Any other variant claims knowledge (which vendor) A doesn't have.

## Why this is silent (no safety net catches it)
- `PhoneVerdict.reasons` is typed `string[]`, not `ReasonCode[]`
  (`compliance-bridge.ts:27,39`). When C's enum drops `vendor_error`, A's `['vendor_error']`
  emission **still compiles** — no tsc break.
- A's contract test asserts *observed* reasons ∈ `REASON_CODES`, but the fail-closed path
  only fires when C is **unreachable/omitting**; a suite running against a healthy mock C
  never hits :129/:143. So the contract test doesn't catch it either.

Net: without action, A ships a reason string that's no longer in the shared vocabulary,
only on the C-outage path, with nothing failing loudly. That's the worst failure shape for
a compliance audit trail.

## Recommendation (needs a planner call — it's a §12 enum change, not a mechanical rename)
C's own header says adding/removing a code is a §12 change → route through planner. So this
can't be A-self-served. Preferred:

1. **Re-add a service-level code to C's enum** — `compliance_unavailable` (restore the
   dropped one) or `vendor_error_unreachable` — meaning "compliance service returned no
   usable verdict." A maps **both** sites to it. This is the *correct* fix: the condition
   genuinely isn't any of the four vendor variants, and it keeps A's fail-closed semantics
   ("couldn't reach C") distinct from C's vendor-level failures in the audit trail.
2. **Harden A against recurrence** (A-side, I'll do it at PR #2): add a unit test asserting
   A's own fail-closed literal ∈ `REASON_CODES`, so any future enum drift fails loudly at
   test-time instead of silently on the outage path. Optionally tighten `PhoneVerdict.reasons`
   to `ReasonCode[]` for A's *emitted* verdicts (keep `string[]` for C's raw passthrough) so
   tsc guards the emission sites.

## Suggested runbook edit
Change the M2 A-side gate line from "A updates references to dropped coarse codes" to:
> "A hardcodes exactly one dropped code — `vendor_error` (2 sites, both = compliance-service
> unreachable/omission). C's 19 has no service-level replacement (`compliance_unavailable`
> was dropped). **Planner decision required at PR #2:** re-add `compliance_unavailable` /
> `vendor_error_unreachable` for A to map to, OR bless a specific existing target. A adds a
> unit test asserting its fail-closed literal ∈ REASON_CODES."

Nothing else in v1.1 misrepresents my findings — M1/M3/M4/m5/m6 folds all read correctly,
and the rollback annotations match. This is the only re-fold.
