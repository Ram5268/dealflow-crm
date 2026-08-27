# Pacing Control Law (Agent B — Telephony)

The pacing control law is the FTC-abandonment governor for the power/predictive
dialer. It keeps rolling-30-day abandonment under the FTC's 3%-over-30-days
ceiling by adjusting how many lines the dialer opens per operator.

Implemented as a **pure function**: `src/lib/telephony/pacing/computeNewLineCount.ts`.
No I/O, no Prisma, no clock. Fully unit-tested at 100% branch coverage
(`tests/pacing.control-law.test.ts`).

## Inputs

```ts
interface PacingInput {
  currentLineCount: number;
  maxLineCount: number;
  thirtyDayAbandonment: number;    // fraction 0.0–1.0
  amdFalsePositiveRate24h: number; // fraction 0.0–1.0
  monthlySpendUsd: number;
  monthlySpendCapUsd: number;
}
```

## Evaluation order

1. **Spend cap FIRST.** If `monthlySpendUsd >= monthlySpendCapUsd` →
   `{ newLineCount: 0, action: "halt", halt: { reason: "spend" } }`. Nothing
   else is evaluated.
2. **Abandonment band** (below) → `newLineCount` + `action`.
3. **AMD-FP interaction** — applied AFTER the abandonment decision, but ONLY if
   not halted.

## Abandonment bands — half-open intervals `[low, high)`

Let `a = thirtyDayAbandonment`.

| Band | Interval `[low, high)` | Action         | newLineCount              |
|------|------------------------|----------------|---------------------------|
| 1    | `[0.000, 0.015)`       | `increase`     | `min(current + 1, max)`   |
| 2    | `[0.015, 0.020)`       | `hold`         | `current`                 |
| 3    | `[0.020, 0.025)`       | `decrease`     | `max(current - 1, 1)` + `warn` |
| 4    | `[0.025, 0.028)`       | `force-single` | `1` + `warn`              |
| 5    | `[0.028, ∞)`           | `halt`         | `0`, `halt.reason = "abandonment"`, `halt.abandonmentPct = a*100` |

**Boundary truth table** (each boundary value lands in the HIGHER band):

| a       | band |
|---------|------|
| 0.0149  | 1    |
| 0.015   | 2    |
| 0.0199  | 2    |
| 0.020   | 3    |
| 0.0249  | 3    |
| 0.025   | 4    |
| 0.0279  | 4    |
| 0.028   | 5    |
| 0.05    | 5    |

## AMD false-positive interaction

Applied AFTER the abandonment decision, **only when not halted**:

- If `amdFalsePositiveRate24h > 0.015` (strict): set `raiseAmdThreshold = true`
  AND decrease `newLineCount` by 1 (floored at 1).
- If a halt is set by band 5 OR by spend: AMD-FP is **ignored** — halt wins.
  Implementation choice (locked): halt short-circuits *before* the AMD block, so
  `raiseAmdThreshold` is left **unset** on halt.
- The `action` label always reflects the abandonment band. AMD-FP only adjusts
  `newLineCount` and sets `raiseAmdThreshold`; e.g. band-1 `increase` with high
  AMD-FP still reports `action: "increase"` but a shaved `newLineCount`.

## Spend-cap interaction

Checked FIRST (before abandonment). At-or-above cap → `halt` with
`reason: "spend"`. `newLineCount = 0`. Nothing else evaluated.

## Invariant

`newLineCount ∈ {0} ∪ [1, maxLineCount]`.

- `0` is reserved for halt states (abandonment band 5 OR spend).
- Every non-halt decision yields `newLineCount ∈ [1, maxLineCount]`.
- `newLineCount === 0` **iff** `action === "halt"`.
- If `currentLineCount > maxLineCount` on input (out-of-band), the output is
  clamped to `maxLineCount` (on increase, hold, and decrease paths).

## ⚠️ Deliberate abandonment / AMD-FP double-count — DO NOT "fix"

The rolling-abandonment numerator computed by the pacing worker is
`sum(abandonedCalls) + sum(amdFalsePositive)`. The same AMD-false-positive event
contributes to BOTH:

1. the abandonment ratio that drives the halt band, and
2. the standalone AMD-FP rate that drives the `raiseAmdThreshold` branch.

**This is correct, not a bug.** Under 16 CFR 310.4(b)(4) a call answered by a
human but disconnected within 2 seconds of the greeting is an "abandoned call".
An AMD false-positive (machine-detector flags a live human, then Twilio drops
the leg into voicemail treatment or hangs up) IS exactly that class of event, so
it legitimately counts as an abandonment AND as an AMD-FP. Do not de-duplicate.

## Leg-cost accounting note (relevant to spend-cap input)

`Call.cost` is set from Twilio's `Price` on the STATUS CALLBACK for the primary
outbound PSTN leg (Leg A) only. The operator's Voice-SDK client-to-Twilio leg
(Leg B, the conference join) accrues negligible cost and is NOT summed into
`Call.cost`. Therefore the monthly spend-cap math (`sum(Call.cost)`) slightly
UNDER-counts total Twilio spend by the client-side leg. Acceptable for MVP: one
operator, one call at a time, and the cap carries a 20%+ buffer. Revisit if the
under-count exceeds 5% in practice. Per-leg cost tracking would be a schema-drift
proposal (`CallLeg.cost Decimal?`) — not in MVP scope.
