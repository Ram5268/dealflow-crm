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

# `vitest` lives in node_modules/.bin, which is only on PATH when a script is
# invoked through a package manager. Running this file directly —
# `bash scripts/test-all.sh`, which is exactly what CI or a manual gate check
# does — produced `vitest: command not found` and exit 127 from BOTH suites,
# reported as "RESULT: FAILED". A false red: no test ever ran.
#
# Resolve the repo root from this script's own location (not $PWD) so the gate
# behaves identically no matter which directory it is invoked from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

if ! command -v vitest >/dev/null 2>&1; then
  echo "ERROR: vitest not found on PATH (looked in $REPO_ROOT/node_modules/.bin)." >&2
  echo "Run 'pnpm install' first. Refusing to report a gate result." >&2
  exit 127
fi

set +e # both suites must run; do not abort on the first non-zero exit

echo "running suite 1 (shared)"
vitest run
E1=$?

echo "running suite 2 (agent-d)"
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
