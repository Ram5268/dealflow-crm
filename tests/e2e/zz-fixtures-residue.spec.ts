import { test, expect } from '@playwright/test'
import { fixtureResidue, disconnectFixtures } from './fixtures'

/**
 * Runs LAST — Playwright orders spec files by path, hence the `zz-` prefix.
 *
 * Every other spec now builds its own fixtures and deletes them in `afterAll`.
 * This asserts the deletion actually happened, so "the suite passes from a clean
 * database" stays true on the SECOND run and not just the first. A leaked
 * fixture is how the suite got into the state M5.1 exists to fix.
 */
test('fixtures leave no residue behind', async () => {
  const residue = await fixtureResidue()
  await disconnectFixtures()

  // Named per key so a failure says which fixture leaked, not just "not zero".
  for (const [key, count] of Object.entries(residue)) {
    expect(count, `${key} left ${count} row(s) behind`).toBe(0)
  }
})
