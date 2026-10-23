import { defineConfig, devices } from '@playwright/test'

// Dev-only E2E config (M9 acceptance). Runs against the boot-standalone stack.
// Prereq: `npx playwright install chromium` + `pnpm run boot-standalone` in a
// separate shell (with a real ANTHROPIC_API_KEY for the proposed-mapping step).
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  // One worker: every spec builds its fixtures in the SAME Railway database, and
  // several assert exact row counts. Running files in parallel makes one spec's
  // fixtures visible to another's counts. Same reasoning as the vitest config's
  // fileParallelism: false.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: BASE_URL,
    // Brief 50 (PR 18), engineering precaution: the middleware refuses a save
    // (POST/PUT/PATCH/DELETE) that doesn't come from the CRM's own pages, and
    // Playwright's API requests (`request`, `page.request`) send no Origin
    // header at all. Every spec's API setup and clean-up calls are the CRM's
    // own, so they say so; a page's own requests already carry this Origin.
    extraHTTPHeaders: { origin: new URL(BASE_URL).origin },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
