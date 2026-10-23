// Vitest globalSetup — runs ONCE per test run in the main process, before any
// worker. Materializes the merged Prisma schema into the perf DB a single time,
// avoiding the concurrent-`db push` collision that happens when parallel test
// files each try to push.
import "dotenv/config";
import { checkSuite1Databases } from "./live-guard";
import { pushSchema } from "./push-schema";

export default async function setup(): Promise<void> {
  // Brief 41 (H11) + Brief 50 (6.14): both database settings are checked before
  // anything connects. A non-test database is refused; in CI a missing setting
  // stops the run with a plain message instead of letting suites skip; a local
  // run without DATABASE_URL_MAIN goes on with a loud warning.
  const warning = checkSuite1Databases(process.env);
  if (warning) console.warn(warning);
  // The datasource is `env("DATABASE_URL_MAIN")`, but suite 1's own database is
  // DATABASE_URL_PERF: pushSchema points the push there (Brief 50: a dropped
  // connection during the push is retried).
  await pushSchema(process.env.DATABASE_URL_PERF!, "the test suite (DATABASE_URL_PERF)");
}
