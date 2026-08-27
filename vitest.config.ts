import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['contracts/tests/**/*.spec.ts', 'src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
})
