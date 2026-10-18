import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Brief 45 PR D — the Pipeline page in the real app: a local `next dev` on a
 * throwaway *_test database, driven through the browser, checked through the
 * app's own API. It makes its own made-up people ("E2E pipeline owner N",
 * "10N Example St") and three groups, shows only those three columns
 * (?groups=…), and deletes everything it made at the end.
 *
 * It creates and deletes groups, people and saved workflows, so it refuses any
 * server that isn't on this machine [engineering precaution; Ryan, 2026-10-18:
 * groups are never created in production]. Nothing here contacts anyone.
 *
 *   E2E_BASE_URL=http://localhost:3148 PW_CHROMIUM_PATH=<chrome-headless-shell> \
 *     npx playwright test tests/e2e/pipeline.spec.ts
 *
 * Use `localhost`, not 127.0.0.1: Next's dev server serves its dev resources
 * only to its own origin, so on 127.0.0.1 the page never comes alive and no
 * key or drag does anything.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const LOCAL = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)
const STAMP = Date.now().toString(36)
const MOVE = '**/api/core-data/groups/move'

if (process.env.PW_CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } })
test.describe.configure({ mode: 'serial' })

interface MoveBody { leadId: string; fromGroupId: string; toGroupId: string }

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(path)
  expect(res.status(), path).toBe(200)
  return (await res.json()) as T
}
const groupIdsOf = async (request: APIRequestContext, leadId: string) =>
  (await getJson<{ groupIds: string[] }>(request, `/api/core-data/leads/${leadId}/memberships`)).groupIds
/** The lead's group timeline entries, oldest first. */
async function timeline(request: APIRequestContext, leadId: string): Promise<string[]> {
  const r = await getJson<{ activities: { type: string; bodyText: string | null }[] }>(request, `/api/leads/${leadId}/activities?limit=200`)
  return r.activities.filter((a) => a.type === 'Group').map((a) => a.bodyText ?? '').reverse()
}
const card = (page: Page, groupId: string, leadId: string) => page.locator(`[data-column="${groupId}"] [data-card="${leadId}"]`)
const columnsShowing = (page: Page, leadId: string) =>
  page.locator(`[data-card="${leadId}"]`).evaluateAll((els) => els.map((e) => e.closest('[data-column]')!.getAttribute('data-column')))
const focusedCardKey = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-card-key') ?? null)

/** Every move request the page sends, with its body. */
function recordMoves(page: Page): MoveBody[] {
  const sent: MoveBody[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/core-data/groups/move')) sent.push(r.postDataJSON() as MoveBody)
  })
  return sent
}

test.describe('Brief 45 PR D: the Pipeline', () => {
  test.skip(!LOCAL, `refuses ${new URL(BASE).hostname}: this spec creates groups, people and workflows, so it runs only against a local dev server`)

  const G = { a: '', b: '', c: '' }
  const lead: string[] = []
  let board = ''

  // A, B, C as columns (sidebar order = the order they're made in). Owners 0–2
  // in A, 3 in B, 4 in C, and 5 in A and C (one person, two columns).
  test.beforeAll(async ({ request }) => {
    for (let i = 0; i < 6; i++) {
      const res = await request.post('/api/leads', {
        data: { displayName: `E2E pipeline owner ${i} ${STAMP}`, primaryAddressSummary: `10${i} Example St`, source: `e2e-pipeline-${STAMP}` },
      })
      expect(res.status()).toBe(201)
      lead.push(((await res.json()) as { lead: { id: string } }).lead.id)
    }
    for (const k of ['a', 'b', 'c'] as const) {
      const res = await request.post('/api/core-data/groups', { data: { name: `E2E ${k.toUpperCase()} ${STAMP}` } })
      expect(res.status()).toBe(201)
      G[k] = ((await res.json()) as { group: { id: string } }).group.id
    }
    const add = (g: string, ids: string[]) => request.post(`/api/core-data/groups/${g}/members`, { data: { leadIds: ids } })
    await add(G.a, [lead[0], lead[1], lead[2], lead[5]])
    await add(G.b, [lead[3]])
    await add(G.c, [lead[4], lead[5]])
    board = `/pipeline?groups=${G.a},${G.b},${G.c}`
  })

  test.afterAll(async ({ request }) => {
    const { workflows } = await getJson<{ workflows: { id: string; name: string }[] }>(request, '/api/core-data/workflows')
    for (const w of workflows) if (w.name.includes(STAMP)) await request.delete(`/api/core-data/workflows/${w.id}`)
    for (const g of Object.values(G)) if (g) await request.delete(`/api/core-data/groups/${g}`)
    for (const id of lead) await request.delete(`/api/leads/${id}`)
  })

  /** Put a person back in exactly one group (between tests). */
  async function onlyIn(request: APIRequestContext, leadId: string, groupId: string) {
    for (const g of Object.values(G)) {
      if (g !== groupId) await request.delete(`/api/core-data/groups/${g}/members/${leadId}`)
    }
    await request.put(`/api/core-data/groups/${groupId}/members/${leadId}`)
  }

  test('one column per group in sidebar order, with counts; a person in two groups shows in both, marked "Also in"', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(board)
    await expect(page.locator('[data-column]')).toHaveCount(3)
    expect(await page.locator('[data-column]').evaluateAll((els) => els.map((e) => e.getAttribute('data-column')))).toEqual([G.a, G.b, G.c])
    await expect(page.locator(`[data-column-header="${G.a}"]`)).toContainText('4')
    await expect(page.locator(`[data-column-header="${G.c}"]`)).toContainText('2')
    expect(await columnsShowing(page, lead[5])).toEqual([G.a, G.c])
    await expect(card(page, G.a, lead[5]).getByTestId('also-in')).toHaveText(`Also in E2E C ${STAMP}`)
    await expect(card(page, G.c, lead[5]).getByTestId('also-in')).toHaveText(`Also in E2E A ${STAMP}`)
    expect(errors).toEqual([])
  })

  test('] moves the card one column right: one request, out of A into B; focus follows; both timeline entries', async ({ page, request }) => {
    const sent = recordMoves(page)
    const before = (await timeline(request, lead[0])).length
    await page.goto(board)
    await card(page, G.a, lead[0]).focus()
    const done = page.waitForResponse((r) => r.url().endsWith('/api/core-data/groups/move'))
    await page.keyboard.press(']')
    expect((await done).status()).toBe(200)
    expect(sent).toEqual([{ leadId: lead[0], fromGroupId: G.a, toGroupId: G.b }])
    await expect(card(page, G.b, lead[0])).toBeVisible()
    await expect(card(page, G.a, lead[0])).toHaveCount(0)
    await expect.poll(() => focusedCardKey(page)).toBe(`${G.b}:${lead[0]}`)
    expect(await groupIdsOf(request, lead[0])).toEqual([G.b])
    expect((await timeline(request, lead[0])).slice(before)).toEqual([`Removed from E2E A ${STAMP}`, `Added to E2E B ${STAMP}`])

    // [ goes back to the left.
    const back = page.waitForResponse((r) => r.url().endsWith('/api/core-data/groups/move'))
    await page.keyboard.press('[')
    await back
    expect(sent[1]).toEqual({ leadId: lead[0], fromGroupId: G.b, toGroupId: G.a })
    await expect.poll(() => focusedCardKey(page)).toBe(`${G.a}:${lead[0]}`)
    expect(await groupIdsOf(request, lead[0])).toEqual([G.a])
  })

  test('two quick moves of one card (] ]) reach the server one after the other; the person ends in one group', async ({ page, request }) => {
    await onlyIn(request, lead[1], G.a)
    const sent = recordMoves(page)
    await page.goto(board)
    // Hold the first request back (a slow network, a cold start).
    const arrived: number[] = []
    let firstAnswered = 0
    await page.route(MOVE, async (route) => {
      const i = arrived.push(Date.now())
      if (i === 1) await new Promise((r) => setTimeout(r, 1500))
      const response = await route.fetch()
      if (i === 1) firstAnswered = Date.now()
      await route.fulfill({ response })
    })
    await card(page, G.a, lead[1]).focus()
    await page.keyboard.press(']')
    await page.waitForTimeout(150)
    await page.keyboard.press(']')
    await expect.poll(() => arrived.length, { timeout: 10_000 }).toBe(2)
    expect(arrived[1]).toBeGreaterThanOrEqual(firstAnswered) // the second waited for the first
    expect(sent).toEqual([
      { leadId: lead[1], fromGroupId: G.a, toGroupId: G.b },
      { leadId: lead[1], fromGroupId: G.b, toGroupId: G.c },
    ])
    await expect.poll(() => groupIdsOf(request, lead[1])).toEqual([G.c])
    await expect.poll(() => columnsShowing(page, lead[1])).toEqual([G.c])
    await page.unroute(MOVE)
  })

  test('a refused move: the card goes back, a toast gives the reason, focus returns to it, and the moves queued behind it are not sent', async ({ page, request }) => {
    await onlyIn(request, lead[2], G.a)
    const sent = recordMoves(page)
    await page.goto(board)
    await page.route(MOVE, async (route) => {
      await new Promise((r) => setTimeout(r, 400))
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated refusal for the e2e test.' }) })
    })
    await card(page, G.a, lead[2]).focus()
    await page.keyboard.press(']')
    await page.keyboard.press(']') // queued behind the first: never sent
    await expect(page.getByText('Simulated refusal for the e2e test.', { exact: true })).toBeVisible()
    await expect(page.getByText(/Couldn't move E2E pipeline owner 2 .* to E2E B/).first()).toBeVisible()
    await expect(card(page, G.a, lead[2])).toBeVisible()
    await expect.poll(() => columnsShowing(page, lead[2])).toEqual([G.a])
    await expect.poll(() => focusedCardKey(page)).toBe(`${G.a}:${lead[2]}`)
    await page.waitForTimeout(500)
    expect(sent).toEqual([{ leadId: lead[2], fromGroupId: G.a, toGroupId: G.b }])
    expect(await groupIdsOf(request, lead[2])).toEqual([G.a])
    await page.unroute(MOVE)
  })

  test('M or Shift+F10 opens "Move to group…"; keys typed in the menu never move the card; choosing a group does', async ({ page, request }) => {
    await onlyIn(request, lead[0], G.a)
    const sent = recordMoves(page)
    await page.goto(board)
    await card(page, G.a, lead[0]).focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press(']')
    await page.keyboard.press('[')
    await page.waitForTimeout(600)
    expect(sent).toEqual([])
    await page.keyboard.press('Escape')
    await expect.poll(() => focusedCardKey(page)).toBe(`${G.a}:${lead[0]}`)

    await page.keyboard.press('m')
    const done = page.waitForResponse((r) => r.url().endsWith('/api/core-data/groups/move'))
    await page.getByRole('menuitem', { name: new RegExp(`^E2E C ${STAMP}`) }).click()
    await done
    expect(sent).toEqual([{ leadId: lead[0], fromGroupId: G.a, toGroupId: G.c }])
    await expect.poll(() => focusedCardKey(page)).toBe(`${G.c}:${lead[0]}`)
    expect(await groupIdsOf(request, lead[0])).toEqual([G.c])
  })

  test('drag and drop: one request, out of the column it left, into the one it was dropped on', async ({ page, request }) => {
    await onlyIn(request, lead[0], G.c)
    const sent = recordMoves(page)
    await page.goto(board)
    const done = page.waitForResponse((r) => r.url().endsWith('/api/core-data/groups/move'))
    await page.dragAndDrop(`[data-column="${G.c}"] [data-card="${lead[0]}"]`, `[data-column="${G.b}"] ol`)
    expect((await done).status()).toBe(200)
    expect(sent).toEqual([{ leadId: lead[0], fromGroupId: G.c, toGroupId: G.b }])
    await expect(card(page, G.b, lead[0])).toBeVisible()
    expect(await groupIdsOf(request, lead[0])).toEqual([G.b])
  })

  test('filters live in the URL: "In more than one group" shows the person in two groups, in both columns', async ({ page }) => {
    await page.goto(`${board}&multiGroup=1`)
    const shown = await page.locator('[data-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-card')))
    expect(shown).toEqual([lead[5], lead[5]])
    await expect(page.getByRole('button', { name: 'Remove filter: In more than one group' })).toBeVisible()
    await page.getByRole('button', { name: 'Remove filter: In more than one group' }).click()
    await expect(page).not.toHaveURL(/multiGroup/)
  })

  test('a saved workflow: save the screen as a tab, reopen it, rename it, delete it', async ({ page, request }) => {
    await page.goto(`${board}&multiGroup=1`)
    await page.getByRole('button', { name: 'Save as workflow' }).click()
    await page.getByLabel('Name', { exact: true }).fill(`E2E nurtures ${STAMP}`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page).toHaveURL(/wf=/)
    const { workflows } = await getJson<{ workflows: { id: string; name: string; groupIds: string[]; filters: Record<string, string> }[] }>(request, '/api/core-data/workflows')
    const wf = workflows.find((w) => w.name === `E2E nurtures ${STAMP}`)!
    expect(wf).toMatchObject({ groupIds: [G.a, G.b, G.c], filters: { multiGroup: '1' } })

    // The sidebar lists it under Groups ("Workflows") at once, and it opens the tab.
    const tabs = page.getByTestId('workflow-tabs')
    const inSidebar = page.locator('aside').first().getByRole('link', { name: `E2E nurtures ${STAMP}` })
    await expect(inSidebar).toHaveAttribute('href', `/pipeline?wf=${wf.id}`)
    await page.goto('/leads')
    await page.locator('aside').first().getByRole('link', { name: `E2E nurtures ${STAMP}` }).click()
    await expect(page).toHaveURL(new RegExp(`/pipeline\\?wf=${wf.id}$`))
    await expect(page.locator('nav[aria-label="Saved workflows"] a[aria-current="page"]')).toHaveText(`E2E nurtures ${STAMP}`)
    await expect(page.locator('aside').first().getByRole('link', { name: `E2E nurtures ${STAMP}` })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('button', { name: 'Remove filter: In more than one group' })).toBeVisible()
    await expect(page.locator('[data-column]')).toHaveCount(3)

    await page.getByRole('button', { name: `Options for “E2E nurtures ${STAMP}”` }).click()
    await page.getByRole('menuitem', { name: /Rename/ }).click()
    await page.getByLabel('Name', { exact: true }).fill(`E2E renamed ${STAMP}`)
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await expect(tabs.getByRole('link', { name: `E2E renamed ${STAMP}` })).toBeVisible()
    await expect(page.locator('aside').first().getByRole('link', { name: `E2E renamed ${STAMP}` })).toBeVisible() // the sidebar too

    await page.getByRole('button', { name: `Options for “E2E renamed ${STAMP}”` }).click()
    await page.getByRole('menuitem', { name: /Delete/ }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page).not.toHaveURL(/wf=/)
    await expect(page.getByRole('link', { name: `E2E renamed ${STAMP}` })).toHaveCount(0) // tab and sidebar row both gone
    const after = await getJson<{ workflows: { id: string }[] }>(request, '/api/core-data/workflows')
    expect(after.workflows.some((w) => w.id === wf.id)).toBe(false)
  })

  test('a group in the sidebar, or ⌘K "Go to group…", opens the Pipeline on that group, marked open', async ({ page }) => {
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    await aside.locator(`a[data-sidebar-item="${G.b}"]`).click()
    await expect(page).toHaveURL(new RegExp(`/pipeline\\?groups=${G.b}$`))
    await expect(page.locator('[data-column]')).toHaveCount(1)
    await expect(page.locator('[data-column]')).toHaveAttribute('data-column', G.b)
    await expect(aside.locator(`a[data-sidebar-item="${G.b}"]`)).toHaveAttribute('aria-current', 'page')

    await page.goto('/leads', { waitUntil: 'networkidle' }) // the palette's keys work once the page is live
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.getByRole('option', { name: 'Go to group…' }).click()
    await page.getByRole('option', { name: new RegExp(`E2E C ${STAMP}`) }).click()
    await expect(page).toHaveURL(new RegExp(`/pipeline\\?groups=${G.c}$`))
    await expect(page.locator('[data-column]')).toHaveAttribute('data-column', G.c)
  })

  test('the table: one row per person, sorted by name from the URL', async ({ page }) => {
    await page.goto(`${board}&view=table`)
    await expect(page.getByTestId('pipeline-table')).toBeVisible()
    await page.getByRole('button', { name: 'Name', exact: true }).click()
    await expect(page).toHaveURL(/sort=name/)
    const rows = page.locator('[data-testid="pipeline-table"] [data-row]')
    await expect(rows).toHaveCount(6)
    const names = await page.locator('[data-testid="pipeline-table"] tbody tr td:nth-child(3) a').allInnerTexts()
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
  })

  test('a link with junk still opens, with plain notes: a 20-digit page, a malformed workflow id', async ({ page }) => {
    const res = await page.goto(`/pipeline?view=table&groups=${G.a}&page=12345678901234567890&wf=%3Cscript%3E`)
    expect(res?.status()).toBe(200)
    const notes = page.getByTestId('pipeline-notices')
    await expect(notes).toContainText("This link had a page number the Pipeline doesn't know (12345678901234567890), so it was ignored.")
    await expect(notes).toContainText("This link had a saved workflow the Pipeline doesn't know (<script>), so it was ignored.")
    await expect(page.getByTestId('pipeline-table')).toBeVisible()
  })

  test('phone width: the columns snap one per swipe', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: BASE })
    const page = await ctx.newPage()
    await page.goto(board)
    const snap = await page.getByTestId('pipeline-board').evaluate((el) => getComputedStyle(el).scrollSnapType)
    expect(snap).toMatch(/x mandatory/)
    await ctx.close()
  })
})
