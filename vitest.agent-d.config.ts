import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Agent D (Communications) CI config — kept separate so the shared vitest.config
// stays slice-agnostic (mirrors vitest.agent-c.config.ts). The comms unit tests
// are fully mocked (prisma via vi.mock, HTTP via fetch stubs), so this config
// intentionally OMITS the shared globalSetup (perf-DB push) — no live DB needed.
// Brief 41.1 (F11): its own globalSetup refuses to start when the database a
// real Prisma client would use (DATABASE_URL_MAIN, or the checkout's .env) is
// not a *_perf / *_test one, so an unmocked client can't reach the live CRM.
//
// Coverage floor: 85% lines + branches on every product-surface comms dir
// (email/oauth/sequences/sms/templates/clients). `jobs/**` (pg-boss infra) is
// excluded — it's covered by `pnpm worker:smoke`, not unit tests, per the brief's
// coverage-floor set. Run: `pnpm test:coverage:comms`.
export default defineConfig({
  test: {
    include: ['src/lib/comms/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/suite2-db-guard.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage-comms',
      include: ['src/lib/comms/**'],
      exclude: [
        'src/lib/comms/**/*.test.ts',
        'src/lib/comms/jobs/**', // pg-boss infra — worker:smoke-covered, not unit
      ],
      thresholds: {
        'src/lib/comms/email/**': { lines: 85, branches: 85 },
        'src/lib/comms/oauth/**': { lines: 85, branches: 85 },
        'src/lib/comms/sequences/**': { lines: 85, branches: 85 },
        'src/lib/comms/sms/**': { lines: 85, branches: 85 },
        'src/lib/comms/templates/**': { lines: 85, branches: 85 },
        'src/lib/comms/clients/**': { lines: 85, branches: 85 },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
