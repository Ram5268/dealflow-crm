import { mergeConfig, defineConfig } from 'vitest/config'
import base from './vitest.config'

// Agent C CI config: same tests as the shared config, plus the compliance
// coverage floor (95% branches AND lines on the critical paths, per Brief §10).
// Kept separate so the shared vitest.config stays slice-agnostic.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        include: ['src/lib/compliance/**'],
        exclude: ['src/lib/compliance/**/__tests__/**'],
        thresholds: {
          // Legal fail-safe critical paths — 95% floor.
          'src/lib/compliance/timezone/**': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/holidays/**': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/policy/**': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/scrub/**': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/dnc/internal.ts': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/dnc/check.ts': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/litigator/check.ts': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/bulk/circuitBreaker.ts': { branches: 95, lines: 95, functions: 95, statements: 95 },
          'src/lib/compliance/bulk/checkpoint.ts': { branches: 95, lines: 95, functions: 95, statements: 95 },
        },
      },
    },
  })
)
