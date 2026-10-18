# UI notes

How the front end is put together, for whoever touches it next. Agent E's slice.

## Routes

Every route renders real content or an EmptyState that states plainly why it is
empty. There are no blank pages.

| Route | What it is |
|---|---|
| `/` | **Focus** — today's projection: dial queue, calls, replies, tasks, and one ranked "Needs attention" list |
| `/inbox` | Unified inbox — email + SMS + voicemail in one thread list, with a detail pane and reply drawer |
| `/inbox?compose=1` | Threadless email composer |
| `/leads` | Lead list with saved views, search, sorting, pagination |
| `/leads?new=1` | Create-lead form (modal over the list) |
| `/leads/[id]` | Lead detail — details rail, activity timeline, enrol-in-sequence |
| `/pipeline` | **Pipeline** (Brief 45) — one column per group (or a table), filters in the URL, saved workflows as tabs; drag or `[` `]` / `M` to move a card between groups. "Create a group to start your pipeline" while there are no groups |
| `/sequences` | Sequence list |
| `/sequences/new`, `/sequences/[id]`, `/sequences/[id]/edit` | Sequence editor and detail (Steps / Enrollment / Stats) |
| `/templates`, `/templates/new`, `/templates/[id]` | Message templates with merge-tag inserter and live preview |
| `/reports` | **Not built.** No aggregation layer exists; the page says so and links to Focus, Usage and Leads |
| `/settings/*` | Profile, Connected Accounts, Calling, Compliance, Usage — all read-only |
| `/imports`, `/imports/[id]/mapping-review`, `/imports/[id]/progress` | CSV import: upload, review the AI mapping, watch progress |
| `/dialer`, `/queue` | Agent B's surfaces, wrapped in the shell |
| `/%5Fdev/primitives` | Design-system catalog. The `%5F` is deliberate — a bare `_` prefix is a Next private folder and 404s |

## Keyboard

Global, from anywhere:

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `?` or `⌘/` | Shortcuts sheet |
| `Esc` | Close the topmost overlay |
| `g` then `f` / `i` / `l` / `s` / `p` | Go to Focus / Inbox / Leads / Sequences / Pipeline |

Inbox only:

| Keys | Action |
|---|---|
| `j` / `k` | Move down / up the thread list |
| `Enter` | Open the focused thread |
| `r` | Reply |
| `e` | Archive |
| `u` | Toggle read/unread |

Pipeline board only (a card has focus):

| Keys | Action |
|---|---|
| `↑` `↓` `←` `→` | Move between cards |
| `[` / `]` | Move the card to the column on the left / right (out of one group, into the other) |
| `M` (or Shift+F10) | "Move to group…": any group, including ones not shown as columns |
| `Enter` | Open the lead |
| `F2` (a focused workflow tab) | Rename the workflow |

The board's moves are covered end to end by `tests/e2e/pipeline.spec.ts` (local dev server only).

Hotkeys are suppressed while focus is in a text field, except `Esc` — so you can
always dismiss a composer you are typing in. The handler lives in
`src/components/shell/useGlobalHotkeys.ts`; the sheet that documents them is
`ShortcutsSheet.tsx` and must be updated alongside.

## Theme

Three states: `light`, `dark`, and follow-the-system.

- Stored under `localStorage['dealflow-theme']` (`THEME_STORAGE_KEY` in
  `src/lib/ui/theme.ts`).
- With no stored value, `prefers-color-scheme` decides.
- `THEME_INIT_SCRIPT` runs in `<head>` **before first paint** and stamps
  `data-theme` on `<html>`, which is what stops the white flash on load. It is
  wrapped in try/catch because Safari private mode throws on `localStorage`.
- Colours are Tailwind v4 CSS-first tokens in `globals.css` (`--color-fg`,
  `--color-accent`, `--color-line`, …). **Use the tokens, never raw
  `bg-gray-100`** — a hardcoded colour is invisible in one of the two themes.

## Adding a command to ⌘K

`src/components/shell/CommandPalette.tsx`. Two groups:

- **Go to** is generated from `ALL_DESTINATIONS` in `src/lib/ui/nav.ts`. Add the
  route there and it appears in the palette, the sidebar, and the top-bar title
  at once. Give it a `goKey` if it deserves a `g <key>` jump, and the palette
  shows that hint on the right.
- **Actions** is the `ACTIONS` array in the palette itself: `{ id, label, icon,
  href }`.

One rule: **the href must go somewhere that exists.** `/leads?new=1` sat in this
list for four milestones while `/leads` ignored the parameter, so a visible
command did nothing. If an action needs a surface, build the surface first.

## Conventions worth keeping

- **One `<main>` per page.** `AppShell` renders it. A page that renders its own
  produces nested `<main>`, which the browser hoists — the hydration mismatch
  silently kills interactivity on that subtree. This is what broke `/imports`.
- **Server Components read, Client Components mutate.** Pages are `async`
  functions hitting `src/lib/**`; interactivity lives in a `'use client'` child.
- **No new API routes** (§13). Reuse Agent B/C/D's; grep before assuming one is
  missing.
- **Say what is not there.** Where data does not exist — sequence opens and
  bounces, mailbox sync times, reporting — the UI states it rather than
  rendering a zero that reads as real.

## Tests

- `pnpm test` — unit and integration (vitest, two configs chained).
- `npx playwright test` — e2e. Each spec seeds its own fixtures in `beforeAll`
  and deletes them in `afterAll` via `tests/e2e/fixtures.ts`; `workers: 1`
  because every spec shares one database.
- **Run the e2e suite twice.** The first run proves the fixtures build; the
  second proves they were cleaned up and that nothing depends on run order. A
  hydration race in the ⌘K test was invisible on a single run.
- Perf tests assert latency against the shared Railway host. Running them right
  after a full Playwright suite can fail them on contention alone — rest the
  database before reading a red perf run as a regression.
