import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

/**
 * M2 acceptance smokes: top-bar search launcher, Focus/Home (4 panels +
 * "Needs attention"), and /dialer + /queue inside the shell.
 *
 * Prereq: `pnpm dev` in a separate shell.
 * Run: `pnpm exec playwright test m2-focus`
 *
 * See m1-shell.spec.ts for why this uses process.cwd() rather than import.meta.
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

const PANELS = ['Dial queue', 'Calls today', 'Replies today', 'Tasks due']

test.describe('M2 focus + shell', () => {
  test('top-bar search launcher opens the command palette', async ({ page }) => {
    await page.goto('/leads')

    // Scoped to the top bar: M1's sidebar carries its own "Search ⌘K" row, so
    // an unscoped role query matches two controls.
    const launcher = page.getByRole('banner').getByRole('button', { name: /^Search/ })
    await expect(launcher).toBeVisible()
    await expect(launcher).toContainText('⌘K')

    await launcher.click()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()

    // Closing must not immediately relaunch the palette — an <input> that opens
    // on focus would loop here, which is why the launcher is a button.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
    await page.waitForTimeout(300)
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
  })

  test('focus view renders four panels and the needs-attention list', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    for (const label of PANELS) {
      await expect(page.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()

    // The primary action is unconditional — an empty queue must not hide it.
    await expect(page.getByRole('link', { name: 'Start dialing' })).toBeVisible()

    // Every panel resolves to a real number or an explicit em-dash — never a
    // stuck skeleton.
    await expect(page.locator('[aria-hidden="true"].animate-pulse')).toHaveCount(0)

    await shot(page, 'focus-home')
  })

  test('focus view survives dark mode', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    // Repaint settles before the capture (M1 gotcha 9.4).
    await page.waitForTimeout(250)

    const bg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor,
    )
    expect(bg).not.toBe('rgb(255, 255, 255)')

    await shot(page, 'focus-home-dark')
  })

  test('go-to-focus hotkey lands on the focus view', async ({ page }) => {
    await page.goto('/leads')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('g')
    await page.keyboard.press('f')
    await expect(page).toHaveURL(/\/$/)
  })

  test('dialer and queue render inside the shell with one main landmark', async ({ page }) => {
    for (const route of ['/dialer', '/queue']) {
      await page.goto(route)
      await expect(page.getByRole('main')).toHaveCount(1)
      await expect(page.getByRole('banner')).toBeVisible()
      // .first(): /dialer's AmmunitionPanel is also an <aside>, so the sidebar
      // is not the only complementary landmark on the page.
      await expect(page.getByRole('complementary').first()).toBeVisible()
    }
    await shot(page, 'queue')
  })

  test('softphone bar stays hidden while no call is live', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Status-only bar: absent until a call.connected event arrives.
    await expect(page.getByRole('status')).toHaveCount(0)
  })
})
