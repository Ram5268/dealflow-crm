#!/usr/bin/env bash
# Run a gate from the non-iCloud mirror (see docs/agent-e-audit.md §9.7).
#
# iCloud's file provider starves tsc/next of I/O in this repo: a typecheck that
# takes 7s outside iCloud takes 8m17s inside it. This syncs the worktree to a
# mirror and runs the gate there. Edit + commit in the worktree as normal.
#
#   ./scripts/gate.sh tsc      # npx tsc --noEmit
#   ./scripts/gate.sh build    # pnpm build
#   ./scripts/gate.sh test     # pnpm test
#   ./scripts/gate.sh e2e      # playwright, needs `pnpm dev` running in the mirror
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR="${GATE_MIRROR:-$HOME/dev/agent-e-gates}"

mkdir -p "$MIRROR"
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude 'coverage*' --exclude 'reference/dealflow' \
  "$SRC/" "$MIRROR/"

cd "$MIRROR"
[ -d node_modules ] || { pnpm install --prefer-offline; npx prisma generate; }

case "${1:-tsc}" in
  tsc)   npx tsc --noEmit ;;
  build) pnpm build ;;
  test)  pnpm test ;;
  e2e)   npx playwright test "${2:-}" --reporter=list ;;
  *)     echo "usage: gate.sh {tsc|build|test|e2e}" >&2; exit 2 ;;
esac
