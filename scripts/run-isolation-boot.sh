#!/usr/bin/env bash
# Gate 1 — boot the compliance slice in isolation and smoke callable-now.
#
#   pnpm exec doppler run -- bash scripts/run-isolation-boot.sh
#
# Milestone 1 boots WITHOUT any vendor (the callable-now pipeline has no vendor
# step yet — timezone/policy/internal-DNC/window/holiday only). DNC_VENDOR may
# be unset. Requires DATABASE_URL_MAIN pointing at a test database (name ending
# _perf or _test; see README). Brief 41: anything else is refused, with no
# override: this migrates and seeds fake fixtures, which never belong in a live
# database.
set -euo pipefail
cd "$(dirname "$0")/.."

# Env: prefer Doppler when active, else fall back to a plain .env (Agent A/B
# parity — run `bash scripts/run-isolation-boot.sh` with no Doppler). The .env
# must define DATABASE_URL_MAIN (the name schema.prisma's datasource reads).
if [ -z "${DOPPLER_TOKEN:-}" ] && [ -z "${DOPPLER_PROJECT:-}" ] && [ -f .env ]; then
  echo "==> Doppler not active; sourcing .env"
  set -a; . ./.env; set +a
fi
if [ -z "${DATABASE_URL_MAIN:-}" ]; then
  echo "ABORT: DATABASE_URL_MAIN is unset. Add it to .env (or run under Doppler)." >&2
  exit 1
fi
# Brief 41 (H11): this runs `prisma migrate deploy` and seeds fake fixtures, so
# it refuses anything but a test database. No override is passed on (the seed
# step refuses a live database regardless).
pnpm exec tsx scripts/assert-test-db.ts DATABASE_URL_MAIN run-isolation-boot

echo "==> 1/6 iCloud duplicate sweep"
DUPES=$(find . -type f \( -name "* 2.ts" -o -name "* 2.tsx" -o -name "* 2.json" \) -not -path "./node_modules/*" -not -path "./.next/*" -print)
if [ -n "$DUPES" ]; then
  echo "ABORT: iCloud duplicate files present:"; echo "$DUPES"; exit 1
fi

echo "==> 2/6 rm -rf .next"
rm -rf .next

echo "==> 3/6 prisma migrate deploy (additive; Railway dev DB)"
pnpm exec prisma migrate deploy
pnpm exec prisma generate

echo "==> 4/6 seed compliance fixtures"
pnpm exec tsx scripts/seed-compliance-fixtures.ts

echo "==> 5/6 pnpm dev on :3000 (background), mock vendors"
# Mock DNC + litigator vendors so callable-now resolves without live keys.
export DNC_VENDOR=mock LITIGATOR_VENDOR=mock
pnpm dev >/tmp/agent-c-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT
# Wait for the health endpoint to answer.
for i in $(seq 1 60); do
  if curl -sf -H 'x-correlation-id: boot' http://localhost:3000/api/compliance/health >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> 6/6 smoke"
echo "-- health --"
curl -s -H 'x-correlation-id: boot' http://localhost:3000/api/compliance/health | tee /tmp/agent-c-health.json
echo
echo "-- callable-now: cp_nyc_confirmed_01 at a controlled weekday-noon ET instant (expect callable:true) --"
# 2026-01-05T17:00:00Z = Monday 12:00 EST -> in window, non-holiday.
curl -s -X POST http://localhost:3000/api/compliance/callable-now \
  -H 'x-correlation-id: boot' -H 'content-type: application/json' \
  -d '{"contactPhoneIds":["cp_nyc_confirmed_01","cp_notz_01","cp_internal_dnc_01","cp_chi_01"],"atInstant":"2026-01-05T17:00:00Z"}' \
  | tee /tmp/agent-c-callable.json
echo
echo "==> Gate 1 smoke complete. Expected: cp_nyc_confirmed_01 callable:true; cp_notz_01 timezone_unresolved; cp_internal_dnc_01 internal_dnc; cp_chi_01 policy_unconfirmed. Every result has BOTH contactPhoneId and phone."
