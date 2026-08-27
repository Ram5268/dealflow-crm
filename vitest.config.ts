import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'contracts/tests/**/*.spec.ts',
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
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
        // Per-file 85% floor on critical paths (brief §10 Gate 3).
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
        'src/lib/core-data/dealflow-sync/promote.ts': {
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
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
