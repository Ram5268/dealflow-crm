import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { DB_RETRY_LOG_FILE, DB_TEST_RETRY } from '../db-retry'

// Brief 50 (6.14): suite 1's retry settings (the same objects vitest.config.ts
// uses) on a fake flaky connection, without suite 1's database setup. Run by
// tests/unit/db-retry.test.ts only.
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['tests/setup/fixtures/db-retry.fixture.ts'],
    environment: 'node',
    retry: DB_TEST_RETRY,
    setupFiles: [DB_RETRY_LOG_FILE],
  },
})
