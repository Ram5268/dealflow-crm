import { describe, it, expect } from "vitest";
import {
  computeNewLineCount,
  type PacingInput,
} from "@/lib/telephony/pacing/computeNewLineCount";

// Convenience builder — sane non-halting defaults; override per test.
function input(overrides: Partial<PacingInput> = {}): PacingInput {
  return {
    currentLineCount: 2,
    maxLineCount: 3,
    thirtyDayAbandonment: 0.0,
    amdFalsePositiveRate24h: 0.0,
    monthlySpendUsd: 0,
    monthlySpendCapUsd: 200,
    ...overrides,
  };
}

describe("computeNewLineCount — abandonment band boundaries [low, high)", () => {
  // Boundary check table straight from the brief §10 Milestone 1a.
  const cases: Array<{ a: number; band: number; action: string }> = [
    { a: 0.0149, band: 1, action: "increase" },
    { a: 0.015, band: 2, action: "hold" },
    { a: 0.0199, band: 2, action: "hold" },
    { a: 0.02, band: 3, action: "decrease" },
    { a: 0.0249, band: 3, action: "decrease" },
    { a: 0.025, band: 4, action: "force-single" },
    { a: 0.0279, band: 4, action: "force-single" },
    { a: 0.028, band: 5, action: "halt" },
    { a: 0.05, band: 5, action: "halt" },
  ];

  for (const { a, band, action } of cases) {
    it(`a=${a} → band ${band} (${action})`, () => {
      const d = computeNewLineCount(input({ thirtyDayAbandonment: a }));
      expect(d.action).toBe(action);
    });
  }

  it("band 1 increases by 1, capped at maxLineCount", () => {
    expect(
      computeNewLineCount(input({ currentLineCount: 1, maxLineCount: 3, thirtyDayAbandonment: 0.0 }))
        .newLineCount,
    ).toBe(2);
    expect(
      computeNewLineCount(input({ currentLineCount: 3, maxLineCount: 3, thirtyDayAbandonment: 0.0 }))
        .newLineCount,
    ).toBe(3);
  });

  it("band 2 holds current", () => {
    const d = computeNewLineCount(input({ currentLineCount: 2, thirtyDayAbandonment: 0.017 }));
    expect(d.action).toBe("hold");
    expect(d.newLineCount).toBe(2);
    expect(d.warn).toBeUndefined();
  });

  it("band 3 decreases by 1, floor 1, sets warn", () => {
    const d = computeNewLineCount(input({ currentLineCount: 2, thirtyDayAbandonment: 0.022 }));
    expect(d.action).toBe("decrease");
    expect(d.newLineCount).toBe(1);
    expect(d.warn).toBeDefined();
    const floored = computeNewLineCount(input({ currentLineCount: 1, thirtyDayAbandonment: 0.022 }));
    expect(floored.newLineCount).toBe(1); // never below 1
  });

  it("band 4 forces single line, sets warn", () => {
    const d = computeNewLineCount(input({ currentLineCount: 3, thirtyDayAbandonment: 0.026 }));
    expect(d.action).toBe("force-single");
    expect(d.newLineCount).toBe(1);
    expect(d.warn).toBeDefined();
  });

  it("band 5 halts with abandonment reason and abandonmentPct = a*100", () => {
    const d = computeNewLineCount(input({ thirtyDayAbandonment: 0.03 }));
    expect(d.action).toBe("halt");
    expect(d.newLineCount).toBe(0);
    expect(d.halt).toEqual({ reason: "abandonment", abandonmentPct: 3 });
  });
});

describe("computeNewLineCount — currentLineCount clamping vs maxLineCount", () => {
  it("clamps above-max current on the increase path", () => {
    const d = computeNewLineCount(
      input({ currentLineCount: 5, maxLineCount: 3, thirtyDayAbandonment: 0.0 }),
    );
    expect(d.action).toBe("increase");
    expect(d.newLineCount).toBe(3);
  });

  it("clamps above-max current on the hold path", () => {
    const d = computeNewLineCount(
      input({ currentLineCount: 5, maxLineCount: 3, thirtyDayAbandonment: 0.017 }),
    );
    expect(d.action).toBe("hold");
    expect(d.newLineCount).toBe(3);
  });

  it("clamps above-max current on the decrease path", () => {
    const d = computeNewLineCount(
      input({ currentLineCount: 6, maxLineCount: 3, thirtyDayAbandonment: 0.022 }),
    );
    expect(d.action).toBe("decrease");
    expect(d.newLineCount).toBe(3); // max(6-1,1)=5 → clamped to 3
  });
});

describe("computeNewLineCount — AMD false-positive interaction", () => {
  // Threshold is STRICT > 0.015.
  const amdCases = [0.0, 0.015, 0.0151, 0.05];

  for (const amd of amdCases) {
    const high = amd > 0.015;
    it(`amdFP=${amd} → raiseAmdThreshold ${high ? "set" : "unset"} (band 1)`, () => {
      const d = computeNewLineCount(
        input({ currentLineCount: 1, maxLineCount: 3, thirtyDayAbandonment: 0.0, amdFalsePositiveRate24h: amd }),
      );
      if (high) {
        expect(d.raiseAmdThreshold).toBe(true);
      } else {
        expect(d.raiseAmdThreshold).toBeUndefined();
      }
    });
  }

  it("high AMD-FP + low abandonment still decreases by 1 and raises threshold", () => {
    // Band 1, current 2, max 3: increase → 3, then AMD shave → 2.
    const d = computeNewLineCount(
      input({ currentLineCount: 2, maxLineCount: 3, thirtyDayAbandonment: 0.0, amdFalsePositiveRate24h: 0.02 }),
    );
    expect(d.action).toBe("increase");
    expect(d.raiseAmdThreshold).toBe(true);
    expect(d.newLineCount).toBe(2);
  });

  it("AMD-FP shave never drops below 1", () => {
    // Band 3, current 1: decrease → 1, AMD shave floored at 1.
    const d = computeNewLineCount(
      input({ currentLineCount: 1, thirtyDayAbandonment: 0.022, amdFalsePositiveRate24h: 0.05 }),
    );
    expect(d.newLineCount).toBe(1);
    expect(d.raiseAmdThreshold).toBe(true);
  });

  it("AMD-FP boundary at exactly 0.015 does NOT trigger (strict >)", () => {
    const d = computeNewLineCount(
      input({ currentLineCount: 2, maxLineCount: 3, thirtyDayAbandonment: 0.0, amdFalsePositiveRate24h: 0.015 }),
    );
    expect(d.raiseAmdThreshold).toBeUndefined();
    expect(d.newLineCount).toBe(3); // pure increase, no shave
  });
});

describe("computeNewLineCount — spend cap (checked FIRST)", () => {
  it("spend below cap does not halt", () => {
    const d = computeNewLineCount(input({ monthlySpendUsd: 199.99, monthlySpendCapUsd: 200 }));
    expect(d.action).not.toBe("halt");
  });

  it("spend exactly at cap halts with reason spend", () => {
    const d = computeNewLineCount(input({ monthlySpendUsd: 200, monthlySpendCapUsd: 200 }));
    expect(d.action).toBe("halt");
    expect(d.newLineCount).toBe(0);
    expect(d.halt).toEqual({ reason: "spend" });
  });

  it("spend above cap halts with reason spend", () => {
    const d = computeNewLineCount(input({ monthlySpendUsd: 250, monthlySpendCapUsd: 200 }));
    expect(d.halt).toEqual({ reason: "spend" });
  });

  it("spend cap wins over high abandonment (evaluated first, nothing else)", () => {
    const d = computeNewLineCount(
      input({ monthlySpendUsd: 300, monthlySpendCapUsd: 200, thirtyDayAbandonment: 0.05, amdFalsePositiveRate24h: 0.05 }),
    );
    expect(d.halt).toEqual({ reason: "spend" });
    expect(d.raiseAmdThreshold).toBeUndefined(); // AMD not evaluated under halt
    expect(d.warn).toBeUndefined();
  });
});

describe("computeNewLineCount — halt short-circuits AMD-FP", () => {
  it("abandonment halt + high AMD-FP → halt wins, no raiseAmdThreshold", () => {
    const d = computeNewLineCount(
      input({ thirtyDayAbandonment: 0.04, amdFalsePositiveRate24h: 0.05 }),
    );
    expect(d.action).toBe("halt");
    expect(d.halt?.reason).toBe("abandonment");
    // Implementation choice (documented): halt short-circuits before AMD block.
    expect(d.raiseAmdThreshold).toBeUndefined();
  });
});

describe("computeNewLineCount — AMD-FP combined with every abandonment band", () => {
  // amd values × band representatives; asserts invariant holds and shave applies.
  const bandReps = [
    { a: 0.0, band: 1 },
    { a: 0.017, band: 2 },
    { a: 0.022, band: 3 },
    { a: 0.026, band: 4 },
    { a: 0.03, band: 5 },
  ];
  const amds = [0.0, 0.015, 0.0151, 0.05];

  for (const { a, band } of bandReps) {
    for (const amd of amds) {
      it(`band ${band} (a=${a}) × amdFP=${amd} respects invariant`, () => {
        const d = computeNewLineCount(
          input({ currentLineCount: 2, maxLineCount: 3, thirtyDayAbandonment: a, amdFalsePositiveRate24h: amd }),
        );
        const halted = d.action === "halt";
        // Invariant: 0 iff halt; else [1, max].
        if (halted) {
          expect(d.newLineCount).toBe(0);
        } else {
          expect(d.newLineCount).toBeGreaterThanOrEqual(1);
          expect(d.newLineCount).toBeLessThanOrEqual(3);
        }
        // AMD-FP only affects non-halt decisions.
        if (halted) {
          expect(d.raiseAmdThreshold).toBeUndefined();
        } else if (amd > 0.015) {
          expect(d.raiseAmdThreshold).toBe(true);
        }
      });
    }
  }
});

describe("computeNewLineCount — property: newLineCount ∈ {0} ∪ [1,max]; 0 iff halt", () => {
  it("holds across a deterministic sweep of valid inputs", () => {
    // Deterministic pseudo-inputs — no Math.random (banned in workflow scripts,
    // and determinism keeps the property test reproducible).
    for (let i = 0; i < 500; i++) {
      const a = (i % 60) / 1000; // 0.000 .. 0.059
      const max = 1 + (i % 5); // 1..5
      const current = 1 + (i % 7); // 1..7 (can exceed max → exercises clamp)
      const amd = (i % 40) / 1000; // 0.000 .. 0.039
      const spend = i % 3 === 0 ? 250 : 10;
      const cap = 200;
      const d = computeNewLineCount({
        currentLineCount: current,
        maxLineCount: max,
        thirtyDayAbandonment: a,
        amdFalsePositiveRate24h: amd,
        monthlySpendUsd: spend,
        monthlySpendCapUsd: cap,
      });
      if (d.action === "halt") {
        expect(d.newLineCount).toBe(0);
      } else {
        expect(d.newLineCount).toBeGreaterThanOrEqual(1);
        expect(d.newLineCount).toBeLessThanOrEqual(max);
        expect(d.newLineCount).not.toBe(0);
      }
    }
  });
});
