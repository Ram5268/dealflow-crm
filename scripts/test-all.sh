#!/usr/bin/env bash
#
# Runs BOTH vitest suites and aggregates their exit codes.
#
# Why this exists: `pnpm test` used to be
#     vitest run && vitest run --config vitest.agent-d.config.ts
# and `&&` short-circuits. Any failure in suite 1 — including the known
# Railway-latency flake in tests/ammunition.latency.test.ts — meant suite 2
# (237 tests) NEVER RAN. The output still looked like a single ordinary
# failure: no error, no warning, nothing to indicate 237 tests had been
# skipped. Every "834 green" claim made after a suite-1 flake was really
# "596 ran, 237 didn't".
#
# The summary prints on success as well as failure, so the two-suite shape is
# always visible in the log rather than only surfacing when something breaks.

set +e # both suites must run; do not abort on the first non-zero exit

vitest run
E1=$?

vitest run --config vitest.agent-d.config.ts
E2=$?

echo ""
echo "===GATE SUMMARY==="
echo "suite 1 (shared):  exit $E1"
echo "suite 2 (agent-d): exit $E2"

if [ $E1 -ne 0 ] || [ $E2 -ne 0 ]; then
  echo "RESULT: FAILED"
  exit 1
fi

echo "RESULT: PASSED"
exit 0
