/**
 * Milestone 1a — Pacing control law (PURE FUNCTION).
 *
 * No I/O, no Prisma, no imports outside pure Node. This is the FTC-abandonment
 * governor for the predictive/power dialer. It maps a rolling-30-day abandonment
 * fraction (plus a 24h AMD-false-positive rate and month-to-date spend) onto a
 * new line count and an action.
 *
 * Band table (half-open intervals `[low, high)`), a = thirtyDayAbandonment:
 *
 *   Band 1  a ∈ [0.000, 0.015)  increase      min(current + 1, max)
 *   Band 2  a ∈ [0.015, 0.020)  hold          current
 *   Band 3  a ∈ [0.020, 0.025)  decrease      max(current - 1, 1)   (+warn)
 *   Band 4  a ∈ [0.025, 0.028)  force-single  1                     (+warn)
 *   Band 5  a ∈ [0.028, ∞)      halt          0   halt=abandonment
 *
 * Evaluation order:
 *   1. Spend cap FIRST — monthlySpendUsd >= cap → halt(spend), nothing else.
 *   2. Abandonment band → newLineCount + action.
 *   3. AMD-FP interaction — applied AFTER the abandonment decision, but ONLY if
 *      not halted: amdFalsePositiveRate24h > 0.015 sets raiseAmdThreshold and
 *      decreases newLineCount by 1 (floor 1).
 *
 * Deliberate double-count: the abandonment numerator is
 * sum(abandonedCalls)+sum(amdFalsePositive) upstream (see pacing worker). An
 * AMD false-positive is an FTC "abandoned call" under 16 CFR 310.4(b)(4) AND a
 * standalone AMD-FP; the same event legitimately drives both this band decision
 * and the raiseAmdThreshold branch. Not a bug — see docs/pacing-control-law.md.
 *
 * Invariant: newLineCount ∈ {0} ∪ [1, maxLineCount]. `0` is reserved for halt
 * (abandonment band 5 OR spend). Every non-halt decision yields [1, maxLineCount].
 * currentLineCount > maxLineCount on input is clamped to maxLineCount at output.
 */

export interface PacingInput {
  currentLineCount: number;
  maxLineCount: number;
  thirtyDayAbandonment: number; // fraction 0.0–1.0
  amdFalsePositiveRate24h: number; // fraction 0.0–1.0
  monthlySpendUsd: number;
  monthlySpendCapUsd: number;
}

export interface PacingDecision {
  newLineCount: number;
  action: "increase" | "hold" | "decrease" | "force-single" | "halt";
  warn?: string;
  halt?: { reason: "abandonment" | "spend"; abandonmentPct?: number };
  raiseAmdThreshold?: boolean;
}

// Band boundaries as constants so the tests and the function share one source.
export const ABANDONMENT_BANDS = {
  HOLD_FLOOR: 0.015, // band 1 → band 2
  DECREASE_FLOOR: 0.02, // band 2 → band 3
  FORCE_SINGLE_FLOOR: 0.025, // band 3 → band 4
  HALT_FLOOR: 0.028, // band 4 → band 5
} as const;

// AMD false-positive rate above which we raise the AMD threshold and shave a line.
export const AMD_FP_THRESHOLD = 0.015;

export function computeNewLineCount(input: PacingInput): PacingDecision {
  const {
    currentLineCount,
    maxLineCount,
    thirtyDayAbandonment: a,
    amdFalsePositiveRate24h,
    monthlySpendUsd,
    monthlySpendCapUsd,
  } = input;

  // 1. Spend cap FIRST. Halt short-circuits everything (no abandonment/AMD eval).
  if (monthlySpendUsd >= monthlySpendCapUsd) {
    return { newLineCount: 0, action: "halt", halt: { reason: "spend" } };
  }

  // 2. Abandonment band decision.
  let action: PacingDecision["action"];
  let newLineCount: number;
  let warn: string | undefined;

  if (a >= ABANDONMENT_BANDS.HALT_FLOOR) {
    // Band 5 — HALT. Abandonment halt also short-circuits AMD-FP (halt wins).
    return {
      newLineCount: 0,
      action: "halt",
      halt: { reason: "abandonment", abandonmentPct: a * 100 },
    };
  } else if (a >= ABANDONMENT_BANDS.FORCE_SINGLE_FLOOR) {
    // Band 4 — force single line.
    action = "force-single";
    newLineCount = 1;
    warn = `Abandonment ${(a * 100).toFixed(2)}% in [2.5%, 2.8%) — forcing single line.`;
  } else if (a >= ABANDONMENT_BANDS.DECREASE_FLOOR) {
    // Band 3 — decrease by one, floor 1.
    action = "decrease";
    newLineCount = Math.max(currentLineCount - 1, 1);
    warn = `Abandonment ${(a * 100).toFixed(2)}% in [2.0%, 2.5%) — decreasing line count.`;
  } else if (a >= ABANDONMENT_BANDS.HOLD_FLOOR) {
    // Band 2 — hold.
    action = "hold";
    newLineCount = currentLineCount;
  } else {
    // Band 1 — may increase by one, capped at max.
    action = "increase";
    newLineCount = Math.min(currentLineCount + 1, maxLineCount);
  }

  // Clamp non-halt outputs into [1, maxLineCount]. Handles currentLineCount
  // above maxLineCount (hold/decrease paths) and any 0/negative current.
  newLineCount = Math.min(newLineCount, maxLineCount);
  newLineCount = Math.max(newLineCount, 1);

  // 3. AMD-FP interaction — only reached when NOT halted.
  let raiseAmdThreshold: boolean | undefined;
  if (amdFalsePositiveRate24h > AMD_FP_THRESHOLD) {
    raiseAmdThreshold = true;
    newLineCount = Math.max(newLineCount - 1, 1);
  }

  return {
    newLineCount,
    action,
    ...(warn !== undefined ? { warn } : {}),
    ...(raiseAmdThreshold ? { raiseAmdThreshold } : {}),
  };
}
