import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { DB_RETRY_LOG_FILE, DB_TEST_RETRY } from './tests/setup/db-retry'

export default defineConfig({
  test: {
    include: [
      'contracts/tests/**/*.spec.ts',
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      'tests/**/*.test.ts',
    ],
    // Agent D's comms tests run under `vitest.agent-d.config.ts`, NOT here.
    // They are fully mocked (`vi.mock` on prisma, fetch stubs) and need vitest's
    // per-file isolation. This config deliberately sets `isolate: false` to keep
    // A/B/C's DB-backed suites on ONE Prisma pool (see the note below), which
    // collapses every file into a single module registry and lets D's per-file
    // mocks bleed across files. Two configs, one CI run, both green:
    // `pnpm test` chains them.
    exclude: [...configDefaults.exclude, 'src/lib/comms/**'],
    environment: 'node',
    // Materialize the merged Prisma schema into the perf DB ONCE before any
    // worker (avoids the concurrent `db push` collision when parallel files
    // each push). Additive `db push` — non-destructive to A/C test state.
    globalSetup: ['tests/setup/globalSetup.ts'],
    // Brief 50 (6.14): the shared Railway perf DB drops connections at times.
    // A test is retried (at most twice, 2 s apart) only when its error is a
    // dropped connection — never for an assertion or any other error — and the
    // setup file logs every retry. See tests/setup/db-retry.ts.
    retry: DB_TEST_RETRY,
    setupFiles: [DB_RETRY_LOG_FILE],
    // Every DB-backed suite hits ONE remote Railway DB with a small connection
    // cap. Per-file isolation would open a fresh Prisma pool per file and leak
    // connections until Railway's limit is hit (30s pool_timeout stalls). So run
    // the WHOLE suite in a single process sharing ONE Prisma pool: no
    // per-file reconnect, no connection pile-up.
    pool: 'forks',
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/app/**', 'src/**/*.test.ts', 'src/types/**'],
      thresholds: {
        lines: 70,
        // Per-file 85% floor on core-data critical paths (brief §10 Gate 3).
        'src/lib/core-data/query-dsl/compiler.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/query-dsl/executor.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/smart-view/queue-service.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/importer/commit-worker.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/importer/dedup.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/dealflow-sync/sync.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/dealflow-sync/write.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/events/demux.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        'src/lib/core-data/events/emit.ts': {
          lines: 85,
          functions: 85,
          branches: 80,
        },
        // Telephony Gate 3 floors (brief §11): 90% branch on pacing +
        // race-resolver (critical paths), 80% elsewhere in the slice.
        'src/lib/telephony/pacing/**': {
          branches: 90, functions: 90, lines: 90, statements: 90,
        },
        'src/lib/telephony/race-resolver/**': {
          branches: 90, functions: 90, lines: 90, statements: 90,
        },
        'src/lib/telephony/**': {
          branches: 80, functions: 80, lines: 80, statements: 80,
        },
      },
    },
  },
  resolve: {
    alias: {
      // fileURLToPath decodes %20 etc.; new URL().pathname would leave the
      // iCloud path's spaces percent-encoded and break module resolution.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
