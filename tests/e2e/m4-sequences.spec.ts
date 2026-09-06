import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { seedSequenceLead, cleanSequences, disconnectFixtures } from './fixtures'

/**
 * M4 acceptance smokes: Templates CRUD, Sequences CRUD, enrollment.
 *
 * Templates and sequences are created BY these tests through the UI rather than
 * seeded, because "CRUD works end-to-end" is the acceptance criterion. Only the
 * lead + contact that enrollment targets is seeded, by this file (M5.1) — it
 * used to come from a [M4_SMOKE] seed deleted at the end of the milestone.
 *
 * Serial: sequences cannot be built until a template exists.
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')
const MARK = '[M4_SMOKE]'

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

test.describe.configure({ mode: 'serial' })

test.describe('M4 sequences + templates', () => {
  test.beforeAll(async () => {
    await seedSequenceLead()
  })

  // Also removes the templates and sequences the cases below create in the UI.
  test.afterAll(async () => {
    await cleanSequences()
    await disconnectFixtures()
  })

  test('creates a template, with merge tags rendering in the preview', async ({ page }) => {
    await page.goto('/templates')
    await page.waitForLoadState('networkidle')

    await page.getByRole('link', { name: /New template/ }).first().click()
    await expect(page).toHaveURL(/\/templates\/new/)

    await page.getByLabel('Name').fill(`${MARK} Showing follow-up`)
    await page.getByLabel('Subject').fill('About {{lead.primaryAddressSummary}}')
    await page.getByLabel('Body', { exact: true }).fill('Hi {{contact.firstName}} — thanks for touring.')

    // Preview substitutes sample values rather than echoing the raw tag.
    await expect(page.getByText('Hi Dana — thanks for touring.')).toBeVisible()
    await expect(page.getByText('About 412 W 22nd St, Chelsea')).toBeVisible()
    await shot(page, 'template-editor')

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/templates\/[^/]+$/)

    await page.goto('/templates')
    // Settle before asserting: this navigation lands on a server-rendered list,
    // and the bare assertion's 5s default was not always enough — it failed
    // nondeterministically on pristine main too, not just under load. The same
    // test's opening navigation already waits; this one did not.
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('link', { name: `${MARK} Showing follow-up` })).toBeVisible()
    await shot(page, 'templates-list')
  })

  test('the merge-tag inserter writes a real token into the body', async ({ page }) => {
    await page.goto('/templates/new')
    const body = page.getByLabel('Body', { exact: true })
    await body.fill('Hello ')
    await page.getByRole('button', { name: 'Insert merge tag' }).click()
    await page.getByRole('menuitem', { name: /Contact first name/ }).click()
    await expect(body).toHaveValue('Hello {{contact.firstName}}')
  })

  test('creates a 3-step sequence with distinct waits, ending in SMS', async ({ page }) => {
    // NOTE: there is no standalone "wait" step. D models a delay as `delayHours`
    // ON the step it precedes, so the brief's "email → wait 24h → sms" is two
    // steps, not three. This builds three with distinct delays so each renders
    // unambiguously and the wait semantics are visible.

    await page.goto('/sequences')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: /New sequence/ }).first().click()
    await expect(page).toHaveURL(/\/sequences\/new/)

    await page.getByLabel('Name').fill(`${MARK} Buyer nurture`)

    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Add step' }).click()
    const steps = page.locator('ol > li')
    await expect(steps).toHaveCount(3)

    // Step 1 fires immediately (0h default), step 2 after a day, step 3 after two.
    await steps.nth(1).getByLabel('Delay (hours)').fill('24')
    await steps.nth(2).getByLabel('Delay (hours)').fill('48')
    await steps.nth(2).getByLabel('Type').click()
    await page.getByRole('option', { name: 'SMS' }).click()

    await shot(page, 'sequence-editor')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/sequences\/[^/]+$/)

    // Detail view shows all three steps on the Steps tab.
    await expect(page.locator('ol > li')).toHaveCount(3)
    await expect(page.getByText('Immediately')).toBeVisible()
    await expect(page.getByText('Wait 1d')).toBeVisible()
    await expect(page.getByText('Wait 2d')).toBeVisible()
    await expect(page.getByText('sms')).toBeVisible()
    await shot(page, 'sequence-detail')
  })

  test('there is no condition step type anywhere', async ({ page }) => {
    await page.goto('/sequences/new')
    await page.getByRole('button', { name: 'Add step' }).click()
    await page.getByLabel('Type').click()
    await expect(page.getByRole('option', { name: 'Email' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'SMS' })).toBeVisible()
    // D's stepInputSchema is z.enum(['email','sms']) — a condition step cannot exist.
    await expect(page.getByRole('option', { name: /condition/i })).toHaveCount(0)
  })

  test('edits a sequence and the change persists', async ({ page }) => {
    await page.goto('/sequences')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: `${MARK} Buyer nurture` }).click()
    await page.getByRole('link', { name: 'Edit' }).click()
    await expect(page).toHaveURL(/\/edit$/)

    await page.getByLabel('Name').fill(`${MARK} Buyer nurture v2`)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/sequences\/[^/]+$/)
    await expect(page.getByRole('heading', { name: `${MARK} Buyer nurture v2` })).toBeVisible()
  })

  test('enrolls a lead and it appears on the Enrollment tab', async ({ page }) => {
    await page.goto('/leads')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: 'Dana Whitfield' }).first().click()
    await expect(page).toHaveURL(/\/leads\/[^/]+$/)

    await page.getByRole('button', { name: 'Add to sequence' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal.getByLabel('Sequence').click()
    await page.getByRole('option', { name: new RegExp(`${MARK.replace(/[[\]]/g, '\\$&')} Buyer nurture v2`) }).click()
    await modal.getByRole('button', { name: 'Enroll' }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    await page.goto('/sequences')
    await page.getByRole('link', { name: `${MARK} Buyer nurture v2` }).click()
    await page.getByRole('button', { name: 'Enrollment' }).click()
    await expect(page.getByText('Dana Whitfield').first()).toBeVisible()
    await expect(page.getByText('active').first()).toBeVisible()
    await shot(page, 'sequence-enrollment')
  })

  test('stats tab says what is not tracked instead of inventing a rate', async ({ page }) => {
    await page.goto('/sequences')
    await page.getByRole('link', { name: `${MARK} Buyer nurture v2` }).click()
    await page.getByRole('button', { name: 'Stats' }).click()
    await expect(page.getByText('Open rate · Bounce rate')).toBeVisible()
    await expect(page.getByText(/Not tracked/)).toBeVisible()
  })
})
