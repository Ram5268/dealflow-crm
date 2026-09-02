import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { seedLead, cleanLead, disconnectFixtures } from './fixtures'

/**
 * M6: the /imports hydration fix, ⌘K population, and the routes that were bare.
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

async function openPalette(page: Page) {
  await page.waitForLoadState('networkidle')
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  return palette
}

test.describe('M6 shell', () => {
  test.beforeAll(async () => {
    await seedLead()
  })

  test.afterAll(async () => {
    await cleanLead()
    await disconnectFixtures()
  })

  test('every /imports page renders exactly one main landmark', async ({ page }) => {
    // The bug: each page returned its own <main> INSIDE AppShell's <main>.
    // Nested <main> is invalid, the browser hoists it, and the resulting
    // hydration mismatch silently killed interactivity on the subtree — the
    // file picker and Upload button did nothing when Ryan clicked them.
    await page.goto('/imports')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('main')).toHaveCount(1)
  })

  test('the imports file picker and Upload button are live', async ({ page }) => {
    await page.goto('/imports')
    await page.waitForLoadState('networkidle')

    const fileInput = page.locator('input[type=file]')
    await expect(fileInput).toBeEnabled()

    const upload = page.getByRole('button', { name: /upload/i })
    // Disabled until a file is chosen — proof the control is reacting to state
    // rather than being inert, which is exactly what the hydration bug broke.
    await expect(upload).toBeDisabled()

    const csv = path.join(os.tmpdir(), `m6-picker-${Date.now()}.csv`)
    await fs.writeFile(csv, 'Full Name,Phone\nAvery Lindqvist,+12125550190\n')
    await fileInput.setInputFiles(csv)

    await expect(upload).toBeEnabled()
    await shot(page, 'm6-imports')
    await fs.unlink(csv).catch(() => {})
  })

  test('⌘K lists every navigable page and every primary action', async ({ page }) => {
    await page.goto('/leads')
    const palette = await openPalette(page)

    // Empty query: everything is visible.
    for (const label of ['Focus', 'Inbox', 'Leads', 'Sequences', 'Templates', 'Reports', 'Settings']) {
      await expect(palette.getByRole('option', { name: new RegExp(`^${label}\\b`) })).toBeVisible()
    }
    for (const action of ['New lead', 'Compose email', 'New sequence', 'New template', 'Import CSV']) {
      await expect(palette.getByRole('option', { name: new RegExp(action, 'i') })).toBeVisible()
    }
    await shot(page, 'm6-command-palette')
  })

  test('⌘K fuzzy search narrows, Enter navigates, Esc closes', async ({ page }) => {
    await page.goto('/leads')
    const palette = await openPalette(page)

    await page.keyboard.type('templ')
    await expect(palette.getByRole('option', { name: /Templates/ }).first()).toBeVisible()
    await expect(palette.getByRole('option', { name: /^Focus/ })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // Enter on the top match navigates.
    const again = await openPalette(page)
    await page.keyboard.type('sequences')
    await expect(again.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/sequences/)
  })

  test('the "New lead" action opens a form that creates a lead', async ({ page }) => {
    // ?new=1 was a dead link before M6: both the top bar and ⌘K pointed at it
    // and /leads ignored the parameter entirely.
    await page.goto('/leads')
    const palette = await openPalette(page)
    await palette.getByRole('option', { name: /New lead/i }).click()

    await expect(page).toHaveURL(/new=1/)
    const modal = page.getByRole('dialog', { name: 'New lead' })
    await expect(modal).toBeVisible()

    const create = modal.getByRole('button', { name: 'Create lead' })
    await expect(create).toBeDisabled() // no name yet

    const name = `M6 Palette Lead ${Date.now()}`
    await modal.getByLabel('Name').fill(name)
    await expect(create).toBeEnabled()
    await create.click()

    // Lands on the new lead's detail page.
    await expect(page).toHaveURL(/\/leads\/[^/]+$/, { timeout: 15_000 })
    await expect(page.getByText(name).first()).toBeVisible()

    // Clean up the row this test created.
    const id = page.url().split('/').pop()!
    await page.request.delete(`/api/leads/${id}`).catch(() => {})
  })

  test('the "Compose email" action opens a threadless composer', async ({ page }) => {
    await page.goto('/leads')
    const palette = await openPalette(page)
    await palette.getByRole('option', { name: /Compose email/i }).click()

    await expect(page).toHaveURL(/\/inbox\?compose=1/)
    const drawer = page.getByRole('dialog', { name: /New email/i })
    await expect(drawer).toBeVisible()

    const send = drawer.getByRole('button', { name: 'Send' })
    await expect(send).toBeDisabled()

    // A malformed recipient must not enable Send even with a body present.
    await drawer.getByLabel('To').fill('not-an-address')
    await drawer.getByLabel('Message').fill('Body text.')
    await expect(send).toBeDisabled()
    await expect(drawer.getByText(/valid email address/i)).toBeVisible()

    await drawer.getByLabel('To').fill('someone@example.com')
    await expect(send).toBeEnabled()
    await shot(page, 'm6-compose')

    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/\/inbox(\?|$)/)
  })

  test('reports says it is not built and points somewhere useful', async ({ page }) => {
    await page.goto('/reports')
    await page.waitForLoadState('networkidle')
    // Not a stuck skeleton and not a fake empty chart — an explicit statement.
    await expect(page.getByText(/not built yet/i)).toBeVisible()
    await expect(page.getByRole('link', { name: /Usage/ })).toBeVisible()
  })

  test('every sidebar destination renders without an error boundary', async ({ page }) => {
    for (const href of ['/', '/inbox', '/leads', '/sequences', '/templates', '/reports', '/settings', '/imports', '/dialer', '/queue']) {
      await page.goto(href)
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('main')).toHaveCount(1)
      await expect(page.getByText(/Application error|Unhandled Runtime Error/i)).toHaveCount(0)
    }
  })
})
