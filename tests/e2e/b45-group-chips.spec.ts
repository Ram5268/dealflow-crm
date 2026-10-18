import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Brief 45 PR C — group chips, bulk actions and timeline entries in the real
 * app: a local `next dev` on a throwaway *_test database seeded with made-up
 * leads (~/dev/brief45-crm-lists/tools/seed-screens.ts --organize), driven
 * through the browser, checked through the app's own API.
 *
 * It creates and deletes groups, memberships and a list, so it refuses any
 * server that isn't on this machine [engineering precaution; Ryan, 2026-10-18:
 * folders, lists and groups are never created in production]. Nothing here
 * contacts anyone: calling stays off, and the dialer test only simulates a
 * call inside the browser (no request reaches Twilio or the CRM's call routes).
 *
 *   E2E_BASE_URL=http://127.0.0.1:3147 PW_CHROMIUM_PATH=<chrome-headless-shell> \
 *     npx playwright test tests/e2e/b45-group-chips.spec.ts
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const LOCAL = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)
const STAMP = Date.now().toString(36)
const NEW_GROUP = `Callbacks ${STAMP}`
const NEW_LIST = `Everyone ${STAMP}`

if (process.env.PW_CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } })
test.describe.configure({ mode: 'serial' })

interface Group { id: string; name: string; memberCount: number }
interface Row { leadId: string; displayName: string; groups: { id: string }[] }

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path)
  expect(res.status(), path).toBe(200)
  return (await res.json()) as T
}
const getGroups = async (request: APIRequestContext) => (await getJson<{ groups: Group[] }>(request, '/api/core-data/groups')).groups
const groupIdsOf = async (request: APIRequestContext, leadId: string) =>
  (await getJson<{ groupIds: string[] }>(request, `/api/core-data/leads/${leadId}/memberships`)).groupIds

/** Made-up leads that are in no group yet, in rank order. */
async function ungrouped(request: APIRequestContext, n: number): Promise<Row[]> {
  const page = await getJson<{ rows: Row[] }>(request, '/api/core-data/all-leads?page=2')
  const rows = page.rows.filter((r) => r.groups.length === 0).slice(0, n)
  expect(rows.length).toBe(n)
  return rows
}

function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

test.describe('Brief 45 PR C: group chips, bulk actions, timeline', () => {
  test.skip(!LOCAL, `refuses ${new URL(BASE).hostname}: this spec creates groups and lists, so it runs only against a local dev server`)

  let groups: Group[]
  test.beforeAll(async ({ request }) => {
    groups = await getGroups(request)
    expect(groups.length).toBeGreaterThanOrEqual(3) // seed-screens.ts --organize: Hot, Appointment Set, Nurture
  })

  test('lead page: every group as a chip; a click lights it at once, saves it, and the timeline shows it', async ({ page, request }) => {
    const errors = trackErrors(page)
    const [lead] = await ungrouped(request, 1)
    await page.goto(`/leads/${lead.leadId}`)
    const chips = page.getByTestId('group-chips')
    await expect(chips.locator('[data-group-id]')).toHaveCount(groups.length)
    expect(await chips.locator('[data-group-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group-id')))).toEqual(
      groups.map((g) => g.id),
    )
    await expect(page.getByTestId('group-chip-add')).toBeVisible()
    await expect(page.getByTestId('lead-list-chips')).toContainText('Lists:')

    const first = chips.locator(`[data-group-id="${groups[0].id}"]`)
    const addedEntries = page.getByText(`Added to ${groups[0].name}`, { exact: true })
    const removedEntries = page.getByText(`Removed from ${groups[0].name}`, { exact: true })
    const addedBefore = await addedEntries.count()
    // Hold the save, to see the chip light up before the CRM answers.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const memberUrl = `**/api/core-data/groups/${groups[0].id}/members/${lead.leadId}`
    await page.route(memberUrl, async (route) => {
      await held
      await route.continue()
    })
    const saved = page.waitForResponse((r) => r.url().endsWith(`/members/${lead.leadId}`) && r.request().method() === 'PUT')
    await first.click()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    release()
    expect((await saved).status()).toBe(200)
    await page.unroute(memberUrl)
    // The page refreshes its timeline after the change: one new entry.
    await expect(addedEntries).toHaveCount(addedBefore + 1)
    expect(await groupIdsOf(request, lead.leadId)).toEqual([groups[0].id])

    await page.reload()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    const removedBefore = await removedEntries.count()
    const removed = page.waitForResponse((r) => r.url().endsWith(`/members/${lead.leadId}`) && r.request().method() === 'DELETE')
    await first.click()
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    expect((await removed).status()).toBe(200)
    await expect(removedEntries).toHaveCount(removedBefore + 1)
    expect(await groupIdsOf(request, lead.leadId)).toEqual([])
    expect(errors).toEqual([])
  })

  test('keys 1–9 toggle groups on the lead page, and never while typing', async ({ page, request }) => {
    const [, lead] = await ungrouped(request, 2)
    await page.goto(`/leads/${lead.leadId}`)
    const second = page.getByTestId('group-chips').locator(`[data-group-id="${groups[1].id}"]`)
    await expect(second).toHaveAttribute('aria-pressed', 'false')
    await expect(second).toHaveAttribute('aria-keyshortcuts', '2')

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('2')
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => groupIdsOf(request, lead.leadId)).toEqual([groups[1].id])

    // A "2" typed into a text field leaves the chips alone.
    await page.getByTestId('group-chip-add').click()
    await page.getByLabel('New group name').pressSequentially('2')
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape') // closes the box; focus is back on "+", inside the card
    const removedEntries = page.getByText(`Removed from ${groups[1].name}`, { exact: true })
    const removedBefore = await removedEntries.count()
    await page.keyboard.press('2')
    await expect(second).toHaveAttribute('aria-pressed', 'false')
    await expect(removedEntries).toHaveCount(removedBefore + 1)
    await expect.poll(() => groupIdsOf(request, lead.leadId)).toEqual([])
  })

  test('a change the CRM refuses goes back, with a plain-English toast', async ({ page, request }) => {
    const [, , lead] = await ungrouped(request, 3)
    await page.goto(`/leads/${lead.leadId}`)
    const third = page.getByTestId('group-chips').locator(`[data-group-id="${groups[2].id}"]`)
    await page.route('**/api/core-data/groups/*/members/*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The CRM had a hiccup (test).' }) }),
    )
    await third.click()
    await expect(page.getByText(`Couldn't add to ${groups[2].name}`, { exact: true })).toBeVisible()
    await expect(page.getByText('The CRM had a hiccup (test).', { exact: true })).toBeVisible()
    await expect(third).toHaveAttribute('aria-pressed', 'false')
    await page.unroute('**/api/core-data/groups/*/members/*')
    expect(await groupIdsOf(request, lead.leadId)).toEqual([])
  })

  test('"+" makes a group and adds the person in one step; a taken name says so', async ({ page, request }) => {
    const [lead] = await ungrouped(request, 1)
    await page.goto(`/leads/${lead.leadId}`)
    const chips = page.getByTestId('group-chips')
    await page.getByTestId('group-chip-add').click()
    await page.getByLabel('New group name').fill(NEW_GROUP)
    await page.keyboard.press('Enter')
    const made = chips.locator('[data-group-id]', { hasText: NEW_GROUP })
    await expect(made).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(`Added to ${NEW_GROUP}`, { exact: true })).toBeVisible()
    const created = (await getGroups(request)).find((g) => g.name === NEW_GROUP)
    expect(created).toBeDefined()
    expect(await groupIdsOf(request, lead.leadId)).toContain(created!.id)

    await page.getByTestId('group-chip-add').click()
    await page.getByLabel('New group name').fill(groups[0].name.toUpperCase())
    await page.keyboard.press('Enter')
    await expect(chips.getByRole('alert')).toHaveText(`A group named "${groups[0].name}" already exists.`)
    await page.keyboard.press('Escape')

    // Clean up: deleting the group removes the label, never the person.
    expect((await request.delete(`/api/core-data/groups/${created!.id}`)).status()).toBe(200)
  })

  test('Leads: bulk "Add to group", then "Select all N matching" into a new list', async ({ page, request }) => {
    const errors = trackErrors(page)
    await page.goto('/leads')
    const rows = page.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const row = rows.nth(i)
      ids.push((await row.locator('a[href^="/leads/"]').getAttribute('href'))!.split('/').pop()!)
      await row.getByRole('checkbox').click()
    }
    const before = await Promise.all(ids.map((id) => groupIdsOf(request, id)))
    const already = before.filter((g) => g.includes(groups[2].id)).length

    await page.getByRole('button', { name: 'Bulk actions' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: /Add to sequence/ })).toHaveAttribute('aria-disabled', 'true')
    for (const name of ['Add to group…', 'Remove from group…', 'Add to list…', 'Export CSV']) {
      await expect(menu.getByRole('menuitem', { name })).toBeVisible()
    }
    await expect(menu.getByRole('menuitem', { name: 'Remove from this list…' })).toHaveCount(0) // only on a list page
    await menu.getByRole('menuitem', { name: 'Add to group…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Add 3 people to a group')
    await dialog.getByRole('button', { name: new RegExp(`^${groups[2].name}\\b`) }).click()
    const added = 3 - already
    const expected =
      added === 0
        ? `All 3 were already in ${groups[2].name}`
        : `Added ${added} ${added === 1 ? 'person' : 'people'} to ${groups[2].name}${already ? ` · ${already} ${already === 1 ? 'was' : 'were'} already in it` : ''}`
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
    for (const id of ids) expect(await groupIdsOf(request, id)).toContain(groups[2].id)

    // Undo for the next run (bulk remove), then select everyone matching.
    const undo = ids.filter((_, i) => !before[i].includes(groups[2].id))
    expect((await request.delete(`/api/core-data/groups/${groups[2].id}/members`, { data: { leadIds: undo } })).status()).toBe(200)

    const total = Number((await page.getByText(/^1–50 of \d+$/).textContent())!.split(' of ')[1])
    await page.locator('thead').getByRole('checkbox').click()
    const banner = page.getByTestId('select-all-matching')
    await expect(banner).toContainText('All 50 on this page are selected.')
    await banner.getByRole('button', { name: `Select all ${total.toLocaleString('en-US')} matching` }).click()
    await expect(banner).toContainText(`All ${total.toLocaleString('en-US')} matching are selected.`)

    await page.getByRole('button', { name: 'Bulk actions' }).click()
    await page.getByRole('menuitem', { name: 'Add to list…' }).click()
    await dialog.getByLabel('Or make a new list').fill(NEW_LIST)
    await dialog.getByRole('button', { name: 'Make the list' }).click()
    await expect(page.getByText(`Made the list ${NEW_LIST} with ${total.toLocaleString('en-US')} people`, { exact: true })).toBeVisible()

    const lists = (await getJson<{ lists: { id: string; name: string; memberCount: number }[] }>(request, '/api/core-data/lists')).lists
    const list = lists.find((l) => l.name === NEW_LIST)
    expect(list?.memberCount).toBe(total)
    expect((await request.delete(`/api/core-data/lists/${list!.id}`)).status()).toBe(200) // the people stay in the CRM
    expect(errors).toEqual([])
  })

  test('dialer: nothing new without a call; during a (simulated) call the card has the same chips', async ({ page, request }) => {
    // No call: the stream sends nothing.
    await page.route('**/api/telephony/stream', (route) =>
      route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ': keepalive\n\n' }),
    )
    await page.goto('/dialer')
    await expect(page.getByText('No active call')).toBeVisible()
    await expect(page.getByTestId('group-chips')).toHaveCount(0)
    await page.unroute('**/api/telephony/stream')

    // A simulated call, inside this browser only: the stream says "connected"
    // and the Ammunition data names a made-up lead. Calling stays off.
    const [lead] = await ungrouped(request, 1)
    await page.route('**/api/telephony/stream', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify({ type: 'call.connected', callId: 'call_test_b45c' })}\n\n`,
      }),
    )
    await page.route('**/api/telephony/calls/call_test_b45c/ammunition', (route) =>
      route.fulfill({
        json: {
          lead: {
            id: lead.leadId, displayName: lead.displayName, priorityScore: null, topMatchFit: null, captureStatus: null,
            matchReason: null, dealflowDeepLink: null, primaryAddressSummary: null,
          },
          contact: null,
          derivedSignal: null,
        },
      }),
    )
    await page.goto('/dialer')
    const chips = page.getByTestId('group-chips')
    await expect(chips.locator('[data-group-id]')).toHaveCount(groups.length)
    const first = chips.locator(`[data-group-id="${groups[0].id}"]`)

    // Keys need focus in the card here (the softphone keypad sits next to it).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('1')
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('heading', { name: 'Ammunition' }).click()
    await page.keyboard.press('1')
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => groupIdsOf(request, lead.leadId)).toEqual([groups[0].id])
    await first.click()
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => groupIdsOf(request, lead.leadId)).toEqual([])
  })
})
