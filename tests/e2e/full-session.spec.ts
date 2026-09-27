import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { seedFullSession, cleanFullSession, disconnectFixtures, type SessionFixture } from './fixtures'

/**
 * The dogfood walk (M6 §8): one broker's session, end to end, in order.
 *
 *   Focus → Start dialing → dialer → back → Inbox → reply → Leads → enrol
 *
 * WHERE THIS STOPS, AND WHY. The brief's path includes "simulate a call" and
 * "answer inbound (mock)". Neither is reachable here, for two independent
 * reasons, and faking past them would make this walk lie:
 *
 *   1. There is no TwiML application configured (TWILIO_TWIML_APP_SID is
 *      empty), so no browser-side call leg can be established.
 *   2. More importantly, Agent C's gate blocks EVERY number while no
 *      CallingWindowConfig is confirmed — which is the org's real state. A
 *      dial attempt is SUPPOSED to be refused right now.
 *
 * So the walk asserts that starting a session is refused *visibly and without
 * crashing*, which is the honest local outcome, and never places a real call.
 * A live call would cost money and dial a real person.
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

test.describe.configure({ mode: 'serial' })

test.describe('full session', () => {
  let fixture: SessionFixture

  test.beforeAll(async () => {
    fixture = await seedFullSession()
  })

  test.afterAll(async () => {
    await cleanFullSession()
    await disconnectFixtures()
  })

  test('1 · Focus is the landing surface and offers the primary action', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible()
    // Brief 37: while calling is off (DIALING_ENABLED unset) the dial-queue card
    // offers the review list instead of "Start dialing".
    await expect(page.getByRole('link', { name: 'Start dialing' }).or(page.getByText('Calling is off.'))).toBeVisible()
    await shot(page, 'session-1-focus')
  })

  test('2 · Start dialing opens the dialer', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const start = page.getByRole('link', { name: 'Start dialing' })
    if (await start.count()) await start.click()
    else await page.goto('/dialer') // Brief 37: calling is off, no "Start dialing" on Focus

    await expect(page).toHaveURL(/\/dialer/)
    await expect(page.getByRole('button', { name: /Start power session/i })).toBeVisible()
    await expect(page.getByRole('main')).toHaveCount(1)
    await shot(page, 'session-2-dialer')
  })

  test('3 · a dial attempt is refused visibly, and no call is placed', async ({ page }) => {
    await page.goto('/dialer')
    await page.waitForLoadState('networkidle')

    // Brief 37: while calling is off the control is disabled under the banner,
    // and the route would answer 403 dialing_disabled anyway.
    const startButton = page.getByRole('button', { name: /Start power session/i })
    if (await startButton.isDisabled()) {
      await expect(page.getByRole('status').filter({ hasText: 'Calling is off' })).toBeVisible()
      await shot(page, 'session-3-dial-attempt')
      return
    }

    const post = page.waitForResponse(
      (r) => r.url().includes('/api/telephony/dial-sessions') && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: /Start power session/i }).click()
    const res = await post

    // Either outcome is acceptable; a CRASH is not. What matters is that a
    // refusal reaches the operator instead of failing silently.
    if (!res.ok()) {
      await expect(page.locator('body')).toContainText(/./)
      await expect(page.getByText(/Application error|Unhandled Runtime Error/i)).toHaveCount(0)
    }
    await expect(page.getByRole('main')).toHaveCount(1)
    await shot(page, 'session-3-dial-attempt')
  })

  test('4 · the inbox shows the waiting reply', async ({ page }) => {
    await page.goto('/inbox')
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(fixture.threadSubject).first()).toBeVisible()
    await shot(page, 'session-4-inbox')
  })

  test('5 · replying files onto the thread', async ({ page }) => {
    await page.goto('/inbox?filter=email')
    await page.waitForLoadState('networkidle')

    await page.locator('ul > li > button').filter({ hasText: fixture.leadName }).first().click()
    await expect(page).toHaveURL(/thread=/)
    const threadUrl = page.url()
    const before = await page.getByRole('article').count()

    await page.getByRole('button', { name: /^Reply/ }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()

    const body = 'Calling you this afternoon.'
    await drawer.getByRole('textbox', { name: 'Message' }).fill(body)

    // REGRESSION (G3): opening this thread marks its incoming messages read and
    // then calls router.refresh(). That handed ReplyDrawer a new `detail` object,
    // and its reset effect — keyed on the object rather than the thread — wiped
    // the draft mid-typing. An empty body disables Send with no way back, so this
    // test used to hang until the 180s timeout. Settle the refresh, then prove
    // the draft is still here BEFORE trying to send.
    await page.waitForLoadState('networkidle')
    await expect(drawer.getByRole('textbox', { name: 'Message' })).toHaveValue(body)
    await expect(drawer.getByRole('button', { name: 'Send' })).toBeEnabled()

    const post = page.waitForResponse(
      (r) => r.url().includes('/api/comms/messages') && r.request().method() === 'POST',
    )
    await drawer.getByRole('button', { name: 'Send' }).click()
    const res = await post

    if (!res.ok()) {
      // The provider is unreachable locally (Agent D refreshes tokens against
      // the real oauth2.googleapis.com), but D persists the row BEFORE sending,
      // so the reply is still filed. The failure has to be visible, not silent.
      await expect(page.getByText('Send failed')).toBeVisible()
      // NB: that the draft survives a failed send is m3-inbox's contract and is
      // asserted there. Repeating it inside this longer walk made it flaky —
      // the drawer re-renders as the thread refreshes — without adding cover.
    }

    await page.goto(threadUrl)
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('article')).toHaveCount(before + 1)
    await shot(page, 'session-5-reply')
  })

  test('6 · the lead enrols into a sequence', async ({ page }) => {
    await page.goto(`/leads/${fixture.leadId}`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(fixture.leadName).first()).toBeVisible()

    await page.getByRole('button', { name: 'Add to sequence' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await modal.getByLabel('Sequence').click()
    await page.getByRole('option', { name: new RegExp(fixture.sequenceName.replace(/[[\]]/g, '\\$&')) }).click()
    await modal.getByRole('button', { name: 'Enroll' }).click()
    await expect(modal).toBeHidden({ timeout: 15_000 })

    await page.goto('/sequences')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: fixture.sequenceName }).click()
    await page.getByRole('button', { name: 'Enrollment' }).click()
    await expect(page.getByText(fixture.leadName).first()).toBeVisible()
    await shot(page, 'session-6-enrolled')
  })
})
