import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Brief 45 PR B — the Mojo-style sidebar and a list's page in the real app: a
 * local `next dev` on a throwaway *_test database seeded with made-up leads
 * (~/dev/brief45-crm-lists/tools/seed-screens.ts), driven through the browser,
 * checked through the app's own API. It makes its own folder, lists and group
 * (names end in a run stamp) and deletes them at the end.
 *
 * It creates and deletes folders, lists and groups, so it refuses any server
 * that isn't on this machine [engineering precaution; Ryan, 2026-10-18: Ryan
 * creates every folder, list and group himself, never a test]. Nothing here
 * contacts anyone.
 *
 *   E2E_BASE_URL=http://localhost:3146 PW_CHROMIUM_PATH=<chrome-headless-shell> \
 *     npx playwright test tests/e2e/sidebar.spec.ts
 *
 * Use `localhost`, not 127.0.0.1: Next's dev server serves its dev resources
 * only to its own origin.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const LOCAL = ['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)
const STAMP = Date.now().toString(36)
const FOLDER = `Moves ${STAMP}`

if (process.env.PW_CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } })
test.describe.configure({ mode: 'serial' })

interface Item { id: string; name: string; folderId?: string | null }

async function api<T>(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const res = await request.fetch(`/api/core-data${path}`, { method, ...(data !== undefined ? { data } : {}) })
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true)
  return (await res.json()) as T
}
const sidebar = (request: APIRequestContext) => api<{ lists: Item[]; folders: Item[] }>(request, 'GET', '/sidebar')
const folderIdOf = async (request: APIRequestContext, listId: string) => (await sidebar(request)).lists.find((l) => l.id === listId)?.folderId

/** The page's toasts, as text. */
const toasts = async (page: Page) => (await page.locator('ol li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '))

/**
 * Hold the sidebar's reloads for a while, so "snaps back at once" can't be
 * mistaken for the next reload putting things right.
 */
async function holdSidebarReloads(page: Page, ms = 4000): Promise<void> {
  await page.route('**/api/core-data/sidebar', async (route) => {
    await new Promise((r) => setTimeout(r, ms))
    await route.continue().catch(() => {})
  })
}

function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

test.describe('Brief 45 PR B: sidebar moves and the list page', () => {
  test.skip(!LOCAL, `refuses ${new URL(BASE).hostname}: this spec creates folders, lists and groups, so it runs only against a local dev server`)

  let folder: Item
  let mover: Item
  let clash: Item
  let people: Item

  test.beforeAll(async ({ request }) => {
    folder = (await api<{ folder: Item }>(request, 'POST', '/folders', { name: FOLDER })).folder
    mover = (await api<{ list: Item }>(request, 'POST', '/lists', { name: `Mover ${STAMP}` })).list
    // Same name inside the folder and outside it: allowed, until one tries to join the other.
    await api(request, 'POST', '/lists', { name: `Clash ${STAMP}`, folderId: folder.id })
    clash = (await api<{ list: Item }>(request, 'POST', '/lists', { name: `Clash ${STAMP}` })).list
    const ids = (await api<{ ids: string[] }>(request, 'GET', '/all-leads?ids=1')).ids
    expect(ids.length).toBeGreaterThanOrEqual(20) // seed-screens.ts made-up leads
    people = (await api<{ list: Item }>(request, 'POST', '/lists', { name: `People ${STAMP}`, leadIds: ids.slice(0, 60) })).list
  })

  test.afterAll(async ({ request }) => {
    const active = (await sidebar(request)).lists
    const archived = (await api<{ lists: Item[] }>(request, 'GET', '/lists?archived=1')).lists
    for (const l of [...active, ...archived].filter((x) => x.name.endsWith(STAMP))) await api(request, 'DELETE', `/lists/${l.id}`)
    for (const f of (await sidebar(request)).folders.filter((x) => x.name.endsWith(STAMP))) await api(request, 'DELETE', `/folders/${f.id}`)
    const groups = (await api<{ groups: Item[] }>(request, 'GET', '/groups')).groups
    for (const g of groups.filter((x) => x.name.endsWith(STAMP))) await api(request, 'DELETE', `/groups/${g.id}`)
  })

  /** A list is "in the folder" on screen when its link sits inside the folder's <li>. */
  const inFolderOnScreen = async (page: Page, listId: string) =>
    (await page
      .locator('aside')
      .first()
      .locator('li', { has: page.getByRole('button', { name: FOLDER, exact: true }) })
      .locator(`a[data-sidebar-item="${listId}"]`)
      .count()) === 1

  test('a saved drag moves the list, and a list made afterwards still shows (the moved view hands back)', async ({ page, request }) => {
    const errors = trackErrors(page)
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    await aside.locator(`a[data-sidebar-item="${mover.id}"]`).dragTo(aside.getByRole('button', { name: FOLDER, exact: true }))
    await expect.poll(() => folderIdOf(request, mover.id)).toBe(folder.id)
    await expect.poll(() => inFolderOnScreen(page, mover.id)).toBe(true)

    await aside.getByRole('button', { name: 'New list' }).click()
    await aside.locator('input[placeholder="List name"]').fill(`After move ${STAMP}`)
    await aside.locator('input[placeholder="List name"]').press('Enter')
    await expect(aside.getByRole('link', { name: new RegExp(`^After move ${STAMP}`) })).toHaveCount(1)
    expect(errors).toEqual([])
  })

  test("a refused drag snaps back at once, says why in the API's words, and changes nothing", async ({ page, request }) => {
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    await expect(aside.locator(`a[data-sidebar-item="${clash.id}"]`)).toBeVisible()
    await holdSidebarReloads(page)
    await aside.locator(`a[data-sidebar-item="${clash.id}"]`).dragTo(aside.getByRole('button', { name: FOLDER, exact: true }))
    await expect.poll(() => toasts(page), { timeout: 2500 }).toContainEqual(expect.stringContaining(`A list named "Clash ${STAMP}" is already in this folder.`))
    expect((await toasts(page)).some((t) => t.includes("That move didn't save"))).toBe(true)
    // Back outside the folder before any reload could have answered.
    expect(await inFolderOnScreen(page, clash.id)).toBe(false)
    expect(await folderIdOf(request, clash.id)).toBeNull()
  })

  test('the keyboard twin (Shift+F10 → Move to folder…), refused the same way', async ({ page, request }) => {
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    await aside.locator(`a[data-sidebar-item="${clash.id}"]`).focus()
    await holdSidebarReloads(page)
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Move to folder…' }).hover()
    await page.getByRole('menuitem', { name: FOLDER }).click()
    await expect.poll(() => toasts(page), { timeout: 2500 }).toContainEqual(expect.stringContaining(`A list named "Clash ${STAMP}" is already in this folder.`))
    expect(await inFolderOnScreen(page, clash.id)).toBe(false)
    expect(await folderIdOf(request, clash.id)).toBeNull()
  })

  test('a saved keyboard move (⌥↑) reorders inside the folder and sticks after a reload', async ({ page, request }) => {
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    const order = async () => (await sidebar(request)).lists.filter((l) => l.folderId === folder.id).map((l) => l.id)
    const before = await order()
    expect(before[before.length - 1]).toBe(mover.id) // moved in last by the drag
    await aside.locator(`a[data-sidebar-item="${mover.id}"]`).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(order).toEqual([...before.slice(0, -2), mover.id, before[before.length - 2]])
    // After a reload the sidebar loads from the server again (nothing optimistic left).
    await page.reload()
    const onScreen = () =>
      aside
        .locator('li', { has: page.getByRole('button', { name: FOLDER, exact: true }) })
        .locator('a[data-sidebar-item]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-sidebar-item')))
    await expect.poll(onScreen).toEqual(await order())
  })

  test('a double-click on a folder renames it without closing it; a single click opens and closes it', async ({ page }) => {
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    const button = aside.getByRole('button', { name: FOLDER, exact: true })
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await button.dblclick()
    await expect(aside.locator('[data-inline-name] input')).toHaveValue(FOLDER)
    await expect(aside.locator(`a[data-sidebar-item="${mover.id}"]`)).toBeVisible() // still open under the box
    await aside.locator('[data-inline-name] input').press('Escape')
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  test('the drop marker shows only over a place the item can go', async ({ page }) => {
    await page.goto('/leads')
    const aside = page.locator('aside').first()
    const group = (await page.request.post('/api/core-data/groups', { data: { name: `Marker ${STAMP}` } }).then((r) => r.json())).group as Item
    await page.reload()
    // Native drag and drop, step by step (as locator.dragTo does, but stopping on the way).
    const centre = async (selector: string) => {
      const box = (await aside.locator(selector).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const from = await centre(`a[data-sidebar-item="${clash.id}"]`)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // Over another list: a marker on that row.
    const overList = await centre(`a[data-sidebar-item="${people.id}"]`)
    await page.mouse.move(overList.x, overList.y, { steps: 8 })
    await expect(aside.locator('[data-drop]')).toHaveCount(1)
    // Over a group (a list can't go there): no marker anywhere.
    const overGroup = await centre(`a[data-sidebar-item="${group.id}"]`)
    await page.mouse.move(overGroup.x, overGroup.y, { steps: 8 })
    await expect(aside.locator('[data-drop]')).toHaveCount(0)
    await page.mouse.up()
  })

  test('list page: "Clear filters" with a search stays cleared (the search box’s wait can’t bring filters back)', async ({ page }) => {
    await page.goto(`/lists/${people.id}?q=a&strongBuyer=1`)
    await page.getByRole('button', { name: 'Clear filters' }).first().click()
    await page.waitForTimeout(1500) // longer than the 300 ms search wait
    await page.waitForLoadState('networkidle')
    expect(new URL(page.url()).search).toBe('')

    // Typing, then a filter within the wait, keeps both.
    await page.getByLabel('Search this list').fill('a')
    await page.getByRole('button', { name: 'Has a strong buyer' }).click()
    await page.waitForTimeout(1500)
    await page.waitForLoadState('networkidle')
    const sp = new URL(page.url()).searchParams
    expect([sp.get('q'), sp.get('strongBuyer')]).toEqual(['a', '1'])
  })

  test('All leads: "Clear filters" stays cleared on a page slower than the search wait', async ({ page, request }) => {
    const group = (await api<{ group: Item }>(request, 'POST', '/groups', { name: `Filters ${STAMP}` })).group
    await page.route('**/leads?**', async (route) => {
      await new Promise((r) => setTimeout(r, 600))
      await route.continue()
    })
    await page.goto(`/leads?q=zzzz-nobody&group=${group.id}`)
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await page.waitForTimeout(3000)
    await page.waitForLoadState('networkidle')
    const sp = new URL(page.url()).searchParams
    expect([sp.get('q'), sp.get('group')]).toEqual([null, null])
  })

  test('the selection survives a change made in the sidebar; a new filter clears it', async ({ page }) => {
    await page.goto(`/lists/${people.id}`)
    const rows = page.locator('tbody tr')
    await rows.nth(0).locator('button[role="checkbox"]').click()
    await rows.nth(1).locator('button[role="checkbox"]').click()
    await expect(page.getByText('2 selected')).toBeVisible()
    // A sidebar change fires crm:lists-changed, which refreshes this page.
    const aside = page.locator('aside').first()
    await aside.getByRole('button', { name: 'New group' }).click()
    await aside.locator('input[placeholder="Group name"]').fill(`Selection ${STAMP}`)
    await aside.locator('input[placeholder="Group name"]').press('Enter')
    await expect(aside.getByRole('link', { name: new RegExp(`^Selection ${STAMP}`) })).toHaveCount(1)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('2 selected')).toBeVisible()
    await page.getByRole('button', { name: 'Has a strong buyer' }).click()
    await page.waitForURL(/strongBuyer=1/)
    await expect(page.getByText(/\d+ selected/)).toHaveCount(0)
  })

  test('an unknown list is a real 404, in plain English', async ({ page }) => {
    const res = await page.goto('/lists/no-such-list-b45')
    expect(res?.status()).toBe(404)
    await expect(page.getByText('This list doesn’t exist')).toBeVisible()
  })

  test('a 20-digit page number is page 1, never an error', async ({ page }) => {
    const huge = '12345678901234567890'
    const list = await page.goto(`/lists/${people.id}?page=${huge}`)
    expect(list?.status()).toBe(200)
    await expect(page.locator('[data-rank="1"]')).toHaveCount(1)
    const leads = await page.goto(`/leads?page=${huge}`)
    expect(leads?.status()).toBe(200)
    await expect(page.locator('[data-rank="1"]')).toHaveCount(1)
  })
})
