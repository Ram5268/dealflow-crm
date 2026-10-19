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
 *   next dev -H localhost -p 3147   (on the throwaway database)
 *   E2E_BASE_URL=http://localhost:3147 PW_CHROMIUM_PATH=<chrome-headless-shell> \
 *     npx playwright test tests/e2e/b45-group-chips.spec.ts
 *
 * Start the dev server with `-H localhost`: without it, it listens on the
 * whole network, with the login gate off locally. Use `localhost`, not
 * 127.0.0.1, in E2E_BASE_URL: Next's dev server serves its dev resources only
 * to its own origin.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const LOCAL = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)
const STAMP = Date.now().toString(36)
const NEW_GROUP = `Callbacks ${STAMP}`
const NEW_LIST = `Everyone ${STAMP}`
const ROWS_LIST = `Row chips ${STAMP}`

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

/** A made-up list for one test: these leads on it. Deleted by the test (nobody is deleted with it). */
async function makeList(request: APIRequestContext, name: string, leadIds: string[]): Promise<string> {
  const res = await request.post('/api/core-data/lists', { data: { name, leadIds } })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { list: { id: string } }).list.id
}
const memberCountOf = async (request: APIRequestContext, listId: string) =>
  (await getJson<{ memberCount: number }>(request, `/api/core-data/lists/${listId}/members`)).memberCount

/** The Leads counter "1–100 of 400": this page's size (100 in rank order, 50 under a Smart View or a column sort) and the total. */
async function leadsCounter(page: Page): Promise<{ pageSize: number; total: number }> {
  const text = (await page.getByText(/^1–\d+ of \d+$/).textContent())!
  const [, pageSize, total] = /^1–(\d+) of (\d+)$/.exec(text)!
  return { pageSize: Number(pageSize), total: Number(total) }
}

/**
 * The lead page timeline's newest entry (it lists the newest 50, newest
 * first), and a stamp of it, to see a new entry arrive however long the
 * history is.
 */
function newestEntry(page: Page) {
  const entry = page.locator('section', { has: page.getByRole('heading', { name: 'Activity', exact: true }) }).locator('li').first()
  const stamp = async () => ((await entry.count()) ? `${await entry.locator('time').getAttribute('datetime')} ${await entry.innerText()}` : null)
  return { entry, stamp }
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
    const newest = newestEntry(page)
    const before = await newest.stamp()
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
    // The page refreshes its timeline after the change: a new newest entry.
    await expect.poll(newest.stamp).not.toBe(before)
    await expect(newest.entry).toContainText(`Added to ${groups[0].name}`)
    expect(await groupIdsOf(request, lead.leadId)).toEqual([groups[0].id])

    await page.reload()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    const beforeRemove = await newest.stamp()
    const removed = page.waitForResponse((r) => r.url().endsWith(`/members/${lead.leadId}`) && r.request().method() === 'DELETE')
    await first.click()
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    expect((await removed).status()).toBe(200)
    await expect.poll(newest.stamp).not.toBe(beforeRemove)
    await expect(newest.entry).toContainText(`Removed from ${groups[0].name}`)
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
    const newest = newestEntry(page)
    const before = await newest.stamp()
    await page.keyboard.press('2')
    await expect(second).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(newest.stamp).not.toBe(before)
    await expect(newest.entry).toContainText(`Removed from ${groups[1].name}`)
    await expect.poll(() => groupIdsOf(request, lead.leadId)).toEqual([])
  })

  test('a change the CRM refuses goes back, with a plain-English toast', async ({ page, request }) => {
    const [, , lead] = await ungrouped(request, 3)
    await page.goto(`/leads/${lead.leadId}`)
    const third = page.getByTestId('group-chips').locator(`[data-group-id="${groups[2].id}"]`)
    // A server error: its own text isn't for people, so the toast says it plainly.
    await page.route('**/api/core-data/groups/*/members/*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error (test)' }) }),
    )
    await third.click()
    await expect(page.getByText(`Couldn't add to ${groups[2].name}`, { exact: true })).toBeVisible()
    await expect(page.getByText("The CRM couldn't save that just now. Please try again.", { exact: true })).toBeVisible()
    await expect(page.getByText('Internal error (test)')).toHaveCount(0)
    await expect(third).toHaveAttribute('aria-pressed', 'false')
    await page.unroute('**/api/core-data/groups/*/members/*')

    // A refusal the API words for people (e.g. the group was deleted elsewhere) is shown as written.
    await page.route('**/api/core-data/groups/*/members/*', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Group not found.' }) }),
    )
    await third.click()
    await expect(page.getByText('Group not found.', { exact: true })).toBeVisible()
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

    const { pageSize, total } = await leadsCounter(page)
    await page.locator('thead').getByRole('checkbox').click()
    const banner = page.getByTestId('select-all-matching')
    await expect(banner).toContainText(`All ${pageSize} on this page are selected.`)
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

  test('Leads: a new search clears the selection, so a bulk action never reaches people no longer shown', async ({ page }) => {
    await page.goto('/leads')
    await page.locator('thead').getByRole('checkbox').click()
    const banner = page.getByTestId('select-all-matching')
    await banner.getByRole('button', { name: /^Select all [\d,]+ matching$/ }).click()
    await expect(banner).toContainText('matching are selected.')
    await expect(page.getByText(/^[\d,]+ selected$/)).toBeVisible()

    await page.getByLabel('Search leads').fill('Dummerton') // a made-up surname from the seed
    await expect(page.getByText(/^[\d,]+ selected$/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Bulk actions' })).toHaveCount(0)
    await expect(banner).toHaveCount(0)
  })

  test('Leads: a "Select all matching" that finishes after a new search is dropped', async ({ page }) => {
    await page.goto('/leads')
    const isIdsCall = (url: URL) => url.pathname === '/api/core-data/all-leads' && url.searchParams.get('ids') === '1'
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route(isIdsCall, async (route) => {
      await held
      await route.continue()
    })
    await page.locator('thead').getByRole('checkbox').click()
    const banner = page.getByTestId('select-all-matching')
    await banner.getByRole('button', { name: /^Select all [\d,]+ matching$/ }).click()
    await expect(banner).toContainText('Selecting all')

    await page.getByLabel('Search leads').fill('Dummerton')
    await expect(page.getByText(/^[\d,]+ selected$/)).toHaveCount(0)
    const late = page.waitForResponse((r) => isIdsCall(new URL(r.url())))
    release()
    await late
    await page.waitForTimeout(300) // give a late answer the chance to (wrongly) select
    await expect(page.getByText(/^[\d,]+ selected$/)).toHaveCount(0)
    await page.unroute(isIdsCall)
  })

  test('Leads: a bulk action closed while it works still says how it ended', async ({ page }) => {
    await page.goto('/leads')
    const rows = page.locator('tbody tr')
    for (let i = 0; i < 2; i++) await rows.nth(i).getByRole('checkbox').click()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/api/core-data/groups/*/members', async (route) => {
      await held
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error (test)' }) })
    })
    await page.getByRole('button', { name: 'Bulk actions' }).click()
    await page.getByRole('menuitem', { name: 'Add to group…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: new RegExp(`^${groups[0].name}\\b`) }).click()
    await expect(dialog).toContainText('Working…')
    await page.keyboard.press('Escape') // close it while it works
    await expect(dialog).toHaveCount(0)
    release()
    await expect(page.getByText("The bulk action didn't finish", { exact: true })).toBeVisible()
    await expect(page.getByText("The CRM couldn't save that just now. Please try again.", { exact: true })).toBeVisible()
    await page.unroute('**/api/core-data/groups/*/members')
  })

  test('Leads: Export CSV never exports part of a selection that reaches other pages', async ({ page }) => {
    await page.goto('/leads')
    const rows = page.locator('tbody tr')
    const { pageSize } = await leadsCounter(page)
    await rows.nth(0).getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page.getByText(new RegExp(`^${pageSize + 1}–\\d+ of \\d+$`))).toBeVisible()
    await rows.nth(0).getByRole('checkbox').click()
    await expect(page.getByText(/^2 selected$/)).toBeVisible()
    let downloaded = false
    page.on('download', () => (downloaded = true))
    await page.getByRole('button', { name: 'Bulk actions' }).click()
    await page.getByRole('menuitem', { name: 'Export CSV' }).click()
    await expect(page.getByText('Nothing exported', { exact: true })).toBeVisible()
    await expect(page.getByText(/^1 of the 2 selected is on another page\./)).toBeVisible()
    expect(downloaded).toBe(false)
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

  // ─── After PR B: All leads narrowed to a group, and a list's page ─────────

  test('All leads narrowed to a group: "Select all N matching" selects that group only, never the whole CRM', async ({ page, request }) => {
    // A made-up group bigger than a page (100 in rank order), for this test only.
    const made = await request.post('/api/core-data/groups', { data: { name: `Big ${STAMP}` } })
    expect(made.status()).toBe(201)
    const groupId = ((await made.json()) as { group: { id: string } }).group.id
    try {
      const everyone = (await getJson<{ ids: string[] }>(request, '/api/core-data/all-leads?ids=1')).ids
      expect(everyone.length).toBeGreaterThan(150)
      expect((await request.post(`/api/core-data/groups/${groupId}/members`, { data: { leadIds: everyone.slice(0, 150) } })).status()).toBe(200)
      const group = (await getGroups(request)).find((g) => g.id === groupId)
      expect(group?.memberCount).toBe(150)
      const n = group!.memberCount.toLocaleString('en-US')
      const idsCalls: URLSearchParams[] = []
      page.on('request', (r) => {
        const u = new URL(r.url())
        if (u.pathname === '/api/core-data/all-leads' && u.searchParams.get('ids') === '1') idsCalls.push(u.searchParams)
      })
      await page.goto(`/leads?group=${group!.id}`)
      await expect(page.getByText(`Group: ${group!.name}`, { exact: true })).toBeVisible()
      await page.locator('thead').getByRole('checkbox').click()
      const banner = page.getByTestId('select-all-matching')
      await banner.getByRole('button', { name: `Select all ${n} matching` }).click()
      await expect(banner).toContainText(`All ${n} matching are selected.`)
      await expect(page.getByText(`${n} selected`, { exact: true })).toBeVisible()
      expect(idsCalls).toHaveLength(1)
      expect(idsCalls[0].get('group')).toBe(group!.id)

      // Exporting everyone selected carries the group too.
      const exported = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/core-data/all-leads/export')
      await page.getByRole('button', { name: 'Bulk actions' }).click()
      await page.getByRole('menuitem', { name: 'Export CSV' }).click()
      expect(new URL((await exported).url()).searchParams.get('group')).toBe(group!.id)

      // Removing the group filter is a new view: the selection is cleared, as it
      // is for a new search, so it can't outlive the view it was made in.
      await page.getByRole('button', { name: 'Remove the group filter' }).click()
      await expect(page).not.toHaveURL(/group=/)
      await expect(page.getByText(/^[\d,]+ selected$/)).toHaveCount(0)
    } finally {
      // Clean up, even when a check above failed: deleting the group removes the label, never anyone.
      expect((await request.delete(`/api/core-data/groups/${groupId}`)).status()).toBe(200)
    }
  })

  test('list page: compact chips on every row; a click saves without opening the person; keys 1–9 on the focused row', async ({ page, request }) => {
    const leads = await ungrouped(request, 4)
    const listId = await makeList(request, ROWS_LIST, leads.map((l) => l.leadId))
    try {
      await page.goto(`/lists/${listId}`)
      await expect(page.locator('tbody tr')).toHaveCount(4)
      const rowOf = (leadId: string) => page.locator(`tbody tr:has(a[href="/leads/${leadId}"])`)
      const chipsA = rowOf(leads[0].leadId).getByTestId('group-chips')
      await expect(chipsA).toHaveAttribute('data-size', 'compact')
      await expect(chipsA.locator('[data-group-id]')).toHaveCount(groups.length)
      await expect(chipsA.getByTestId('group-chip-add')).toHaveCount(1)

      const a1 = chipsA.locator(`[data-group-id="${groups[0].id}"]`)
      await a1.click()
      await expect(a1).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => groupIdsOf(request, leads[0].leadId)).toEqual([groups[0].id])
      expect(new URL(page.url()).pathname).toBe(`/lists/${listId}`) // the click didn't open the person

      // Keys toggle the focused row only.
      const rowB = rowOf(leads[1].leadId)
      await rowB.focus()
      await page.keyboard.press('2')
      await expect(rowB.locator(`[data-group-id="${groups[1].id}"]`)).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => groupIdsOf(request, leads[1].leadId)).toEqual([groups[1].id])
      expect(await groupIdsOf(request, leads[2].leadId)).toEqual([])
      await page.keyboard.press('2')
      await expect.poll(() => groupIdsOf(request, leads[1].leadId)).toEqual([])
      await a1.click()
      await expect.poll(() => groupIdsOf(request, leads[0].leadId)).toEqual([])
    } finally {
      expect((await request.delete(`/api/core-data/lists/${listId}`)).status()).toBe(200)
    }
  })

  test('list page: a reload that started before a later click can’t flip that row’s chip back', async ({ page, request }) => {
    const [lead] = await ungrouped(request, 1)
    const listId = await makeList(request, `${ROWS_LIST} reload`, [lead.leadId])
    try {
      await page.goto(`/lists/${listId}`)
      const chip = page.locator(`tbody tr:has(a[href="/leads/${lead.leadId}"])`).locator(`[data-group-id="${groups[0].id}"]`)
      await expect(chip).toHaveAttribute('aria-pressed', 'false')
      // Each save makes the page reload its rows (router.refresh). Take each
      // reload's answer from the CRM at once, but deliver it only when told.
      // End to end, two guards keep the saved chip: Next drops a reload that a
      // newer one replaced, and each row's chips are frozen once shown
      // (RowGroupChips). Unfreezing alone doesn't fail this test (checked).
      const gates: (() => void)[] = []
      let reloads = 0
      const thisPage = (url: URL) => url.pathname === `/lists/${listId}`
      await page.route(
        thisPage,
        async (route) => {
          if (route.request().headers()['rsc'] !== '1') return route.continue()
          reloads++
          const response = await route.fetch()
          await new Promise<void>((resolve) => gates.push(resolve))
          await route.fulfill({ response })
        },
      )
      await chip.click() // on: saved, and reload #1 reads "on"
      await expect.poll(() => reloads).toBe(1)
      await chip.click() // off: saved
      await expect.poll(() => groupIdsOf(request, lead.leadId)).toEqual([])
      await expect.poll(() => gates.length).toBeGreaterThanOrEqual(1)
      gates.shift()!() // deliver the stale reload ("on")
      await page.waitForTimeout(800)
      await expect(chip).toHaveAttribute('aria-pressed', 'false') // the saved "off" stays
      while (gates.length) gates.shift()!()
      await page.waitForTimeout(300)
      while (gates.length) gates.shift()!()
      await expect(chip).toHaveAttribute('aria-pressed', 'false')
      await page.unroute(thisPage)
    } finally {
      expect((await request.delete(`/api/core-data/lists/${listId}`)).status()).toBe(200)
    }
  })

  test('list page: bulk "Remove from this list" takes people off this list only; they stay in the CRM', async ({ page, request }) => {
    const leads = await ungrouped(request, 4)
    const name = `${ROWS_LIST} remove`
    const listId = await makeList(request, name, leads.map((l) => l.leadId))
    try {
      await page.goto(`/lists/${listId}`)
      const rows = page.locator('tbody tr')
      await expect(rows).toHaveCount(4)
      for (let i = 0; i < 2; i++) await rows.nth(i).getByRole('checkbox').click()
      await page.getByRole('button', { name: 'Bulk actions' }).click()
      const menu = page.getByRole('menu')
      for (const entry of ['Add to group…', 'Remove from group…', 'Add to list…', 'Remove from this list…', 'Export CSV']) {
        await expect(menu.getByRole('menuitem', { name: entry })).toBeVisible()
      }
      await menu.getByRole('menuitem', { name: 'Remove from this list…' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toContainText(`Remove 2 people from ${name}?`)
      await dialog.getByRole('button', { name: 'Remove from this list' }).click()
      await expect(page.getByText(`Removed 2 people from ${name} · they stay in the CRM`, { exact: true })).toBeVisible()
      await expect(rows).toHaveCount(2)
      expect(await memberCountOf(request, listId)).toBe(2)
      for (const l of leads) expect((await request.get(`/api/core-data/leads/${l.leadId}/memberships`)).status()).toBe(200)
    } finally {
      expect((await request.delete(`/api/core-data/lists/${listId}`)).status()).toBe(200)
    }
  })

  test('list page: "Select all N matching" then Export CSV exports the list; a partial selection exports nothing', async ({ page, request }) => {
    const lists = (await getJson<{ lists: { id: string; name: string; memberCount: number }[] }>(request, '/api/core-data/lists')).lists
    const big = lists.find((l) => l.memberCount > 100) // more than one page of 100
    expect(big).toBeDefined()
    const n = (x: number) => x.toLocaleString('en-US')
    await page.goto(`/lists/${big!.id}`)
    await page.locator('thead').getByRole('checkbox').click()
    const banner = page.getByTestId('select-all-matching')
    await banner.getByRole('button', { name: `Select all ${n(big!.memberCount)} matching` }).click()
    await expect(banner).toContainText(`All ${n(big!.memberCount)} matching are selected.`)

    const exported = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/core-data/lists/${big!.id}/export`)
    await page.getByRole('button', { name: 'Bulk actions' }).click()
    await page.getByRole('menuitem', { name: 'Export CSV' }).click()
    await exported

    await page.locator('tbody tr').nth(0).getByRole('checkbox').click() // one fewer: no longer everyone
    const selected = big!.memberCount - 1
    await page.getByRole('button', { name: 'Bulk actions' }).click()
    await page.getByRole('menuitem', { name: 'Export CSV' }).click()
    await expect(page.getByText('Nothing exported', { exact: true })).toBeVisible()
    // Anchored: the toast's screen-reader copy starts with "Notification …".
    await expect(page.getByText(new RegExp(`^${n(selected - 99)} of the ${n(selected)} selected are on other pages\\.`))).toBeVisible()
  })

  test('list page: a bulk "Add to group" lights those rows’ chips (the rows start again after a bulk change)', async ({ page, request }) => {
    const leads = await ungrouped(request, 3)
    const listId = await makeList(request, `${ROWS_LIST} bulk`, leads.map((l) => l.leadId))
    const made = await request.post('/api/core-data/groups', { data: { name: `Bulk rows ${STAMP}` } })
    expect(made.status()).toBe(201)
    const group = ((await made.json()) as { group: Group }).group
    try {
      await page.goto(`/lists/${listId}`)
      const rowOf = (leadId: string) => page.locator(`tbody tr:has(a[href="/leads/${leadId}"])`)
      const chipOf = (leadId: string) => rowOf(leadId).locator(`[data-group-id="${group.id}"]`)
      await expect(chipOf(leads[0].leadId)).toHaveAttribute('aria-pressed', 'false')
      for (const l of leads.slice(0, 2)) await rowOf(l.leadId).getByRole('checkbox').click()
      await page.getByRole('button', { name: 'Bulk actions' }).click()
      await page.getByRole('menuitem', { name: 'Add to group…' }).click()
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${group.name}`) }).click()
      await expect(page.getByText(`Added 2 people to ${group.name}`, { exact: true })).toBeVisible()
      await expect(chipOf(leads[0].leadId)).toHaveAttribute('aria-pressed', 'true')
      await expect(chipOf(leads[1].leadId)).toHaveAttribute('aria-pressed', 'true')
      await expect(chipOf(leads[2].leadId)).toHaveAttribute('aria-pressed', 'false')
    } finally {
      expect((await request.delete(`/api/core-data/groups/${group.id}`)).status()).toBe(200)
      expect((await request.delete(`/api/core-data/lists/${listId}`)).status()).toBe(200)
    }
  })

  test('list page with filters: "Select all N matching" and its export cover the filtered people only', async ({ page, request }) => {
    // A list and a filter that both reach past one page of 100 (made-up seed data).
    const lists = (await getJson<{ lists: { id: string; memberCount: number }[] }>(request, '/api/core-data/lists')).lists
    let pick: { id: string; filter: string; total: number } | undefined
    for (const l of lists.filter((x) => x.memberCount > 100)) {
      for (const filter of ['borough=Brooklyn', 'group=none']) {
        const { total } = await getJson<{ total: number }>(request, `/api/core-data/lists/${l.id}/members?${filter}`)
        if (total > 100 && total < l.memberCount && !pick) pick = { id: l.id, filter, total }
      }
    }
    expect(pick, 'the seed has a list and a filter past one page').toBeDefined()
    const [key, value] = pick!.filter.split('=')
    const idsCalls: URLSearchParams[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (u.pathname === `/api/core-data/lists/${pick!.id}/members` && u.searchParams.get('ids') === '1') idsCalls.push(u.searchParams)
    })
    await page.goto(`/lists/${pick!.id}?${pick!.filter}`)
    await page.locator('thead').getByRole('checkbox').click()
    const banner = page.getByTestId('select-all-matching')
    const n = pick!.total.toLocaleString('en-US')
    await banner.getByRole('button', { name: `Select all ${n} matching` }).click()
    await expect(banner).toContainText(`All ${n} matching are selected.`)
    await expect(page.getByText(`${n} selected`, { exact: true })).toBeVisible()
    expect(idsCalls).toHaveLength(1)
    expect(idsCalls[0].get(key)).toBe(value)
    const exported = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/core-data/lists/${pick!.id}/export`)
    await page.getByRole('button', { name: 'Bulk actions' }).click()
    await page.getByRole('menuitem', { name: 'Export CSV' }).click()
    expect(new URL((await exported).url()).searchParams.get(key)).toBe(value)
  })

  test('list page: a "Select all matching" that finishes after a filter change is dropped', async ({ page, request }) => {
    const lists = (await getJson<{ lists: { id: string; memberCount: number }[] }>(request, '/api/core-data/lists')).lists
    const big = lists.find((l) => l.memberCount > 100)!
    await page.goto(`/lists/${big.id}`)
    await expect(page.locator('tbody tr').first()).toBeVisible()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const idsUrl = (url: URL) => url.pathname === `/api/core-data/lists/${big.id}/members` && url.searchParams.get('ids') === '1'
    await page.route(idsUrl, async (route) => {
      await held
      await route.continue()
    })
    await page.locator('thead').getByRole('checkbox').click()
    const answered = page.waitForResponse((r) => idsUrl(new URL(r.url())))
    await page.getByTestId('select-all-matching').getByRole('button', { name: /^Select all [\d,]+ matching$/ }).click()
    await page.getByRole('button', { name: 'Has a strong buyer' }).click() // a new view while the ids are on their way
    await expect(page).toHaveURL(/strongBuyer=1/)
    release()
    await answered
    await page.waitForTimeout(500)
    await expect(page.getByText(/^[\d,]+ selected$/)).toHaveCount(0)
    await page.unroute(idsUrl)
  })
})
