# Perf Report — 25k Smart-View Queries (Milestone 1)

**Target:** p95 < 500ms, p99 < 1000ms across 20 realistic Smart-View queries at 25k+ rows.
**Result:** PASS — overall **p95 ≈ 95ms**, p99 ≈ 101ms, over the remote Railway proxy (network RTT ≈ 80ms is the dominant term, so query execution itself is single-digit-ms).

Seed (`scripts/seed-dev.ts`, `DATABASE_URL_PERF`): 25,000 Lead + 24,999 Contact + 33,332 ContactPhone + 10 CustomFieldDefinition + 50,000 CustomFieldValue. ~66% phone coverage (mirrors empirical DealFlow).

Harness: `scripts/perf-25k.ts` (importable `runPerfSuite`; asserted in `tests/perf/25k.test.ts`). 8 timed runs per query after one warm-up.

| Query | p50 | p95 |
|---|---|---|
| match_all | 84 | 87 |
| status in [Hot,Warm] | 84 | 91 |
| priority >= 50 | 83 | 87 |
| priority between 30..70 | 83 | 91 |
| displayName contains | 89 | 91 |
| mojoId exact | 77 | 78 |
| custom number >= 1M (EXISTS) | 78 | 81 |
| custom text contains (EXISTS) | 83 | 85 |
| has_related contact title=Owner | 93 | 97 |
| phone type=mobile (auto-EXISTS) | 94 | 101 |
| and(status in, priority gte) | 83 | 84 |
| or(status Hot, priority gte 80) | 82 | 86 |
| object_type contact | 93 | 101 |
| nested 3-level and/or | 83 | 86 |
| captureStatus term in | 83 | 88 |
| createdAt after | 90 | 94 |
| name full_words (regex) | 91 | 94 |
| topMatchFit gte 50 | 83 | 163 |
| and(phone mobile, priority gte) | 92 | 97 |
| source contains import: | 87 | 93 |
| **OVERALL** | **85** | **95** |

Run standalone: `pnpm run seed:perf && pnpm run perf` (or `pnpm run test:perf`).

**Since Brief 50 (2026-10-19):** `tests/perf/25k.test.ts` seeds this data itself (`seedPerf` in `scripts/seed-dev.ts`) into its own schema, `perf_25k`, of the suite's test database (`DATABASE_URL_PERF`, a `*_perf` or `*_test` database only), and drops that schema afterwards, so no hand seed is needed and CI's db-suite runs it. The seed is made up: fictional streets ("N Example St") and phones only in 555-0100..0199.
