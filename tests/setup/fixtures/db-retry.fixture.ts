import { it, expect } from 'vitest'

// Brief 50 (6.14): fixture for tests/unit/db-retry.test.ts, run only through
// db-retry.vitest.config.ts (no suite includes *.fixture.ts). A fake flaky
// connection: no database is involved, and the address is made up.

let flaky = 0
it('a query whose connection drops once', () => {
  flaky += 1
  console.log(`flaky attempt ${flaky}`)
  if (flaky === 1) {
    throw Object.assign(new Error("Can't reach database server at `db.invalid:5432`"), {
      name: 'PrismaClientInitializationError',
    })
  }
  expect(flaky).toBe(2)
})

let assertion = 0
it('a real assertion failure', () => {
  assertion += 1
  console.log(`assertion attempt ${assertion}`)
  expect(1 + 1).toBe(3)
})

let down = 0
it('a database that stays down', () => {
  down += 1
  console.log(`down attempt ${down}`)
  throw new Error('Connection terminated unexpectedly')
})
