// Vitest globalSetup — runs ONCE per test run in the main process, before any
// worker. Materializes the merged Prisma schema into the perf DB a single time,
// avoiding the concurrent-`db push` collision that happens when parallel test
// files each try to push.
import "dotenv/config";
import { execSync } from "node:child_process";
import { assertTestDatabase } from "../../src/lib/shared/db-guard";

export default function setup(): void {
  // The datasource is `env("DATABASE_URL_MAIN")`, but `.env` ships that var
  // EMPTY (this worktree only ever talks to the perf DB). Point the schema push
  // at the perf DB explicitly. We validate the URL here because an empty/garbage
  // value surfaces downstream as an opaque Prisma P1012 "protocol" error.
  const url = process.env.DATABASE_URL_PERF;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      "DATABASE_URL_PERF missing or not a postgres URL — expected the Railway dealflow_crm_perf connection string in agent-b/.env.",
    );
  }
  // Brief 41 (H11): the suite writes (schema push, test rows), so it refuses any
  // database that isn't *_perf / *_test, including a live DATABASE_URL_MAIN that
  // a checkout's .env may carry (the integration-local suites use MAIN).
  assertTestDatabase(url, "the test suite (DATABASE_URL_PERF)", { allowOverride: false });
  if (process.env.DATABASE_URL_MAIN) {
    assertTestDatabase(process.env.DATABASE_URL_MAIN, "the test suite (DATABASE_URL_MAIN)", { allowOverride: false });
  }
  // --accept-data-loss: additive index/default changes (§13 S1/S2) are flagged
  // as potentially destructive by `db push`; the perf DB is disposable test data.
  execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL_MAIN: url },
  });
}
