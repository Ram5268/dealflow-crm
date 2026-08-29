import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

/**
 * M1 acceptance smokes (brief §8): primitives catalog, shell navigation, ⌘K
 * palette, /leads, /leads/[id], dark mode.
 *
 * Prereq: `pnpm dev` in a separate shell (the primitives catalog is dev-only).
 * Run: `pnpm exec playwright test m1-shell`
 *
 * process.cwd(), not import.meta.url: this package is CommonJS, so `import.meta`
 * is a syntax error here. (Brief §10's fileURLToPath rule applies to the ESM
 * vitest config, not to Playwright specs.) Playwright resolves from the project
 * root, so cwd is the right anchor.
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

test.describe('M1 shell', () => {
  test('sidebar renders every primary destination and navigates', async ({ page }) => {
    await page.goto('/leads')

    const sidebar = page.getByRole('complementary')
    for (const label of ['Focus', 'Inbox', 'Leads', 'Sequences', 'Templates', 'Reports', 'Settings']) {
      await expect(sidebar.getByRole('link', { name: label, exact: true })).toBeVisible()
    }

    await sidebar.getByRole('link', { name: 'Sequences', exact: true }).click()
    await expect(page).toHaveURL(/\/sequences$/)
    await expect(page.getByRole('heading', { name: 'Sequences' })).toBeVisible()

    await sidebar.getByRole('link', { name: 'Leads', exact: true }).click()
    await expect(page).toHaveURL(/\/leads/)
    await shot(page, 'leads-list')
  })

  test('⌘K opens the command palette and Esc closes it', async ({ page }) => {
    await page.goto('/leads')

    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await shot(page, 'command-palette')

    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
  })

  test('g l jumps to Leads from another page', async ({ page }) => {
    await page.goto('/settings')
    // Wait for hydration: the global keydown listener is attached by an effect,
    // so a keypress fired before hydration is simply lost and the `g` never arms.
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('g')
    await page.keyboard.press('l')
    await expect(page).toHaveURL(/\/leads/, { timeout: 10_000 })
  })

  test('leads list shows rows or a labelled empty state', async ({ page }) => {
    await page.goto('/leads')
    await expect(page.getByRole('heading', { name: 'Leads' })).toBeVisible()
    await expect(page.getByLabel('Search leads')).toBeVisible()

    const rows = page.locator('tbody tr')
    const empty = page.getByText('No leads yet')
    // Whichever state the DB is in, the page must resolve to one of them.
    await expect(rows.first().or(empty)).toBeVisible()
  })

  test('lead detail loads for the first row', async ({ page }) => {
    await page.goto('/leads')
    const firstLink = page.locator('tbody tr a').first()
    test.skip((await firstLink.count()) === 0, 'no leads seeded in this DB')

    await firstLink.click()
    await expect(page).toHaveURL(/\/leads\/[^/]+$/)
    // Property + Contacts + Activity cards are the M1 detail contract.
    await expect(page.getByRole('heading', { name: 'Property' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await shot(page, 'lead-detail')
  })

  test('dark mode toggles and persists the choice', async ({ page }) => {
    await page.goto('/leads')
    const html = page.locator('html')

    await page.getByRole('button', { name: /You|Ryan/ }).first().click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()
    await expect(html).toHaveAttribute('data-theme', 'dark')
    // The attribute lands before the repaint does; without a settle the
    // screenshot catches a half-painted frame (stale light pills on dark chrome).
    await page.waitForTimeout(250)
    await shot(page, 'leads-list-dark')

    // Survives a reload — the <head> script reads the stored preference.
    await page.reload()
    await expect(html).toHaveAttribute('data-theme', 'dark')
  })

  test('primitives catalog renders every section', async ({ page }) => {
    await page.goto('/_dev/primitives')
    await expect(page.getByRole('heading', { name: 'Primitives' })).toBeVisible()
    for (const section of ['Button', 'Overlays', 'Table', 'EmptyState']) {
      await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible()
    }
    await shot(page, 'primitives')
  })
})
