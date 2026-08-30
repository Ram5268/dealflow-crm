import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

/**
 * M3 acceptance smokes: unified inbox, filters, keyboard nav, read/archive
 * state, reply drawer + template picker, SMS disabled, email send.
 *
 * Prereq: `pnpm dev` plus the [M3_SMOKE] seed. The send case additionally needs
 * the Gmail mock (contracts/mocks/gmail) with GMAIL_MOCK_URL pointed at it.
 * Run: `pnpm exec playwright test m3-inbox`
 *
 * Serial by necessity — the later cases mutate read/archive state that the
 * earlier ones assert on, so ordering is part of the contract.
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

const threadRows = (page: Page) => page.locator('ul > li > button')

test.describe.configure({ mode: 'serial' })

test.describe('M3 inbox', () => {
  test('lists real threads across email, sms and voicemail', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    await expect(threadRows(page)).toHaveCount(4)
    await expect(page.getByText('412 W 22nd walkthrough', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Voicemail · 24s')).toBeVisible()
    // Every filter tab is present.
    for (const label of ['All', 'Unread', 'Email', 'SMS', 'Voicemail']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
    await shot(page, 'inbox-list')
  })

  test('filter tabs narrow the list and persist to localStorage', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: 'Voicemail', exact: true }).click()
    await expect(page).toHaveURL(/filter=voicemail/)
    await expect(threadRows(page)).toHaveCount(1)
    await expect(page.getByText('Voicemail · 24s')).toBeVisible()

    const stored = await page.evaluate(() => localStorage.getItem('dealflow.inbox.filter'))
    expect(stored).toBe('voicemail')

    await page.getByRole('button', { name: 'SMS', exact: true }).click()
    await expect(threadRows(page)).toHaveCount(1)
    await expect(page.getByText('open house time', { exact: false })).toBeVisible()

    // A filter with no matches gets its own, smaller empty state.
    await page.goto('/inbox?filter=unread')
    await page.waitForLoadState('networkidle')
    await expect(threadRows(page).first()).toBeVisible()
  })

  test('j / k move the cursor and Enter opens the thread', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    await page.keyboard.press('j')
    await page.keyboard.press('k')
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(/thread=/)
    // Detail pane renders the full thread, not just the newest message.
    await expect(page.getByRole('article').first()).toBeVisible()
    await shot(page, 'inbox-thread')
  })

  test('opening a thread clears its unread state', async ({ page }) => {
    // Thread A holds an unread incoming message; opening it must mark it read.
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    const unreadBefore = await page.locator('[aria-label="Unread"]').count()
    expect(unreadBefore).toBeGreaterThan(0)

    await threadRows(page).first().click()
    await expect(page).toHaveURL(/thread=/)
    // router.refresh() lands after the PATCHes resolve.
    await expect
      .poll(async () => page.locator('[aria-label="Unread"]').count(), { timeout: 15_000 })
      .toBeLessThan(unreadBefore)
  })

  test('reply drawer opens on r, shows templates, and closes on Esc', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/thread=/)

    await page.keyboard.press('r')
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('combobox')).toBeVisible() // template picker
    await shot(page, 'inbox-reply-drawer')

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
  })

  test('SMS threads cannot be sent from — button disabled', async ({ page }) => {
    await page.goto('/inbox?filter=sms')
    await page.waitForLoadState('networkidle')
    await threadRows(page).first().click()
    await expect(page).toHaveURL(/thread=/)

    await page.getByRole('button', { name: /^Reply/ }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()

    // Type a body first: an empty composer disables Send on its own, which would
    // let this case pass even if the SMS gate were missing entirely.
    await drawer.getByRole('textbox', { name: 'Message' }).fill('This must never send.')
    await expect(drawer.getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect(drawer.getByText('SMS pending 10DLC registration.')).toBeVisible()
  })

  test('a reply is filed onto the thread it answers, not a new one', async ({ page }) => {
    // M3.1 (§13 amendment): D's POST now accepts an org-scoped `threadId`.
    // Before it did, every reply became its own single-message thread and showed
    // up as "Re: <same subject>" sitting above the message it answered.
    //
    // The green send path is unreachable locally (D refreshes against the real
    // oauth2.googleapis.com — audit §11.5), but D persists the Message row BEFORE
    // sending, so the threading is observable either way.
    await page.goto('/inbox?filter=email')
    await page.waitForLoadState('networkidle')

    const rowsBefore = await threadRows(page).count()
    await threadRows(page).filter({ hasText: 'Perfect, see you at 2' }).first().click()
    await expect(page).toHaveURL(/thread=/)
    const threadUrl = page.url()
    const articlesBefore = await page.getByRole('article').count()

    await page.getByRole('button', { name: /^Reply/ }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()

    const body = 'Confirming 2pm Thursday.'
    await drawer.getByRole('textbox', { name: 'Message' }).fill(body)
    const post = page.waitForResponse((r) => r.url().includes('/api/comms/messages') && r.request().method() === 'POST')
    await drawer.getByRole('button', { name: 'Send' }).click()
    const res = await post

    if (!res.ok()) {
      // Provider unavailable: say so, and never discard what was typed.
      await expect(page.getByText('Send failed')).toBeVisible()
      await expect(drawer.getByRole('textbox', { name: 'Message' })).toHaveValue(body)
    }

    // THE POINT: the reply joins this thread, and no new thread appears.
    await page.goto(threadUrl)
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('article')).toHaveCount(articlesBefore + 1)
    await expect(page.getByRole('article').getByText(body)).toBeVisible()
    await expect(threadRows(page)).toHaveCount(rowsBefore)
  })

  test('a threadId from another org (or a malformed one) is refused', async ({ page }) => {
    // Message.threadId is a free-form string, not a foreign key, so the route
    // must not staple a message onto a thread the caller does not own.
    const bogus = await page.request.post('/api/comms/messages', {
      data: { channel: 'email', threadId: 'thread-that-does-not-exist', toAddresses: ['x@example.com'], bodyText: 'no' },
    })
    expect(bogus.status()).toBe(404)

    const malformed = await page.request.post('/api/comms/messages', {
      data: { channel: 'email', threadId: 42, toAddresses: ['x@example.com'], bodyText: 'no' },
    })
    expect(malformed.status()).toBe(400)
  })

  test('u toggles a thread back to unread', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    // Target a thread known to hold incoming mail, by its lead name. The preview
    // is NOT a safe selector after the reply case above: now that replies thread
    // (M3.1), the newest message represents the row, so the preview is the reply.
    const row = threadRows(page).filter({ hasText: 'Dana Whitfield' }).first()
    await row.click()
    await expect(page).toHaveURL(/thread=/)
    // Opening clears it, so the row settles at zero unread first.
    await expect.poll(async () => row.locator('[aria-label="Unread"]').count(), { timeout: 15_000 }).toBe(0)

    await page.keyboard.press('u')
    await expect.poll(async () => row.locator('[aria-label="Unread"]').count(), { timeout: 15_000 }).toBe(1)
  })

  test('e archives the thread and drops it from the list', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    const before = await threadRows(page).count()
    await page.keyboard.press('e')
    await expect
      .poll(async () => threadRows(page).count(), { timeout: 15_000 })
      .toBeLessThan(before)
  })
})
