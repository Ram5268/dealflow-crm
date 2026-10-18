import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

/**
 * M5 acceptance smokes: the five settings sub-pages, the rail, and the two
 * OAuth actions.
 *
 * NOTHING here writes OAuthCredential — not directly, and not by letting the
 * UI do it. The connected state is read from whatever credentials already
 * exist, and the disconnect test INTERCEPTS the revoke call rather than
 * letting it fire, because a real revoke would blank Agent D's live tokens.
 * (Fleet landmine, M3.)
 */
const SHOT_DIR = path.join(process.cwd(), 'reference', 'dealflow')

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true })
}

const SECTIONS = ['Profile', 'Connected Accounts', 'Calling', 'Compliance', 'Usage'] as const

test.describe('M5 settings', () => {
  test('bare /settings lands on Profile and the rail lists all five sections', async ({ page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/settings\/profile$/)

    const rail = page.getByRole('navigation', { name: 'Settings sections' })
    for (const label of SECTIONS) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible()
    }
    // Exactly one row is current, and it is the one we landed on.
    await expect(rail.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(rail.locator('[aria-current="page"]')).toHaveText('Profile')

    await shot(page, 'm5-settings-profile')
  })

  test('the rail navigates to every section and the panel swaps', async ({ page }) => {
    await page.goto('/settings/profile')
    await page.waitForLoadState('networkidle')
    const rail = page.getByRole('navigation', { name: 'Settings sections' })

    for (const label of SECTIONS) {
      await rail.getByRole('link', { name: label }).click()
      // The heading is the panel's own <h2>, not the rail row.
      await expect(page.getByRole('heading', { level: 2, name: label })).toBeVisible()
      await expect(rail.locator('[aria-current="page"]')).toHaveText(label)
    }
  })

  test('profile is read-only and says why', async ({ page }) => {
    await page.goto('/settings/profile')
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('Display name', { exact: true })).toBeVisible()
    await expect(page.getByText('Timezone', { exact: true })).toBeVisible()
    await expect(page.getByText(/Editable when auth lands/i)).toBeVisible()
    // Nothing on this page pretends to be editable.
    await expect(page.locator('main input:not([type=hidden])')).toHaveCount(0)
  })

  test('connected accounts reflects stored credentials and links to D\'s authorize route', async ({
    page,
  }) => {
    await page.goto('/settings/connected-accounts')
    await page.waitForLoadState('networkidle')

    const gmail = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Gmail' }) })
    const outlook = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Outlook' }) })
    await expect(gmail).toBeVisible()
    await expect(outlook).toBeVisible()

    // Each card carries the correct authorize href. Note the provider-name
    // asymmetry: authorize is `msft`, revoke is `outlook`.
    await expect(gmail.getByRole('link')).toHaveAttribute(
      'href',
      '/api/comms/oauth/gmail/authorize',
    )
    // Brief 41.2: Outlook is paused unless GRAPH_ENABLED is exactly 'true'
    // (Ryan's instruction); its card then says so and carries no link.
    const health = await (await page.request.get('/api/comms/health')).json()
    if (health.checks.graphEnabled) {
      await expect(outlook.getByRole('link')).toHaveAttribute(
        'href',
        '/api/comms/oauth/msft/authorize',
      )
    } else {
      await expect(outlook.getByText(/^Outlook is paused/)).toBeVisible()
      await expect(outlook.getByRole('link')).toHaveCount(0)
    }

    // Outlook's local-only revocation is disclosed wherever it is connected.
    if (await outlook.getByRole('button', { name: 'Disconnect' }).isVisible()) {
      await expect(outlook.getByText(/sign out of Microsoft separately/i)).toBeVisible()
    }

    await shot(page, 'm5-settings-connected-accounts')
  })

  test('disconnect posts to the revoke route (intercepted, never actually revoked)', async ({
    page,
  }) => {
    await page.goto('/settings/connected-accounts')
    await page.waitForLoadState('networkidle')

    const gmail = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Gmail' }) })
    const disconnect = gmail.getByRole('button', { name: 'Disconnect' })
    test.skip(!(await disconnect.isVisible()), 'Gmail is not connected in this environment')

    const seen: Array<{ url: string; method: string }> = []
    await page.route('**/api/oauth/**/revoke', async (route) => {
      seen.push({ url: route.request().url(), method: route.request().method() })
      // Fulfilled locally: the real route would blank D's tokens.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ revoked: true, provider: 'gmail', remoteRevocation: true }),
      })
    })

    await disconnect.click()
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toContain('/api/oauth/gmail/revoke')
    // `exact` avoids also matching Radix's aria-live announcer node.
    await expect(page.getByText('Gmail disconnected', { exact: true })).toBeVisible()
  })

  test('compliance states the real calling-window verdict, not a hardcoded window', async ({
    page,
  }) => {
    await page.goto('/settings/compliance')
    await page.waitForLoadState('networkidle')

    // C's gate blocks every number in a timezone with no confirmed
    // CallingWindowConfig. Whichever state this org is in, the page must agree
    // with the gate — it must never print hours while nothing is confirmed.
    const blocked = page.getByText(/No calling policy is confirmed/i)
    if (await blocked.isVisible()) {
      await expect(page.getByText('policy_unconfirmed')).toBeVisible()
      // The failure this guards: advertising callable hours while blocked.
      await expect(page.getByText(/Open right now/i)).toHaveCount(0)
    } else {
      // A policy IS confirmed — then hours must be shown for it.
      await expect(page.getByText(/(am|pm)–\d+(am|pm)/)).toBeVisible()
    }

    // Suppression vendors are display-only: no control toggles compliance.
    await expect(page.getByText('DNC scrub', { exact: true })).toBeVisible()
    await expect(page.getByText('Litigator scrub', { exact: true })).toBeVisible()
    await expect(page.locator('main input[type=checkbox], main button[role=switch]')).toHaveCount(0)

    await shot(page, 'm5-settings-compliance')
  })

  test('usage shows month-to-date spend against the cap with a progress bar', async ({ page }) => {
    await page.goto('/settings/usage')
    await page.waitForLoadState('networkidle')

    const bar = page.getByRole('progressbar', { name: /spend against cap/i })
    await expect(bar).toBeVisible()

    const now = Number(await bar.getAttribute('aria-valuenow'))
    expect(now).toBeGreaterThanOrEqual(0)
    expect(now).toBeLessThanOrEqual(100)

    await expect(page.getByText('Calls placed', { exact: true })).toBeVisible()
    await expect(page.getByText('Minutes used', { exact: true })).toBeVisible()
    await expect(page.getByText('Spend cap', { exact: true })).toBeVisible()
    // The cap is a real dollar figure, not a placeholder.
    await expect(page.getByText(/\$\d[\d,]*\.\d{2}/).first()).toBeVisible()

    await shot(page, 'm5-settings-usage')
  })

  test('calling shows env-sourced config and the pacing band table', async ({ page }) => {
    await page.goto('/settings/calling')
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('Caller ID', { exact: true })).toBeVisible()
    await expect(page.getByText('Ring timeout', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pacing bands' })).toBeVisible()

    // Five bands, ending in Halt — derived from B's exported thresholds.
    const rows = page.locator('table tbody tr')
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(4)).toContainText('Halt')

    await shot(page, 'm5-settings-calling')
  })
})
