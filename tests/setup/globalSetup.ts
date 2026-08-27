// Vitest globalSetup — runs ONCE per test run in the main process, before any
// worker. Materializes the frozen Prisma schema into the perf DB a single time,
// avoiding the concurrent-`db push` collision that happens when parallel test
// files each try to push.
import "dotenv/config";
import { execSync } from "node:child_process";

export default function setup(): void {
  const url = process.env.DATABASE_URL_PERF;
  if (!url) {
    throw new Error("DATABASE_URL_PERF not set — expected in agent-b/.env (Railway dealflow_crm_perf).");
  }
  execSync("node_modules/.bin/prisma db push --skip-generate", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL_MAIN: url },
  });
}
