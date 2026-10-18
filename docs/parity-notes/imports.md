# Imports — intentional divergence

DealFlow before: `reference/dealflow/11-imports-before.png`;
after: `reference/dealflow/11-imports-after.png`. **No Close reference.**

## Why there is no reference
Close has no top-level imports route — `app.close.com/imports/` 404s, which
PR-A's batch capture confirmed. Close imports contacts through a per-lead CSV
upload buried in a settings flow; DealFlow's `/imports` is a **Mojo-replacement
surface** built to move a whole book of business in one pass, with an AI
mapping-review step Close has no equivalent for. Matching it to anything on
Close would mean inventing a reference. Per the planner's PR-E ruling this is
**accepted as legitimate divergence**: Close's *design language* is applied,
its *flow* is not imitated, and the upload → mapping review → progress →
results shape stays exactly as Agent E built it.

## Defect found — dark mode was broken, not just off-style
All three import pages were still on the raw Tailwind palette:
`text-neutral-600`, `text-neutral-500`, `border-neutral-300`, `bg-neutral-50`,
`bg-neutral-100`, `border-neutral-100`, `bg-blue-600`, `text-red-600`,
`bg-red-50`, `text-red-700`. Those compile to **static hexes**, so they never
respond to the theme.

Measured by flipping `data-theme` and reading computed style:

| | light | dark (before) |
|---|---|---|
| label colour | `lab(34.924 0 0)` | `lab(34.924 0 0)` — **identical** |
| input border | `lab(84.92 0 0)` | `lab(84.92 0 0)` — **identical** |
| submit button | `lab(44.06 29.03 -86.04)` | identical (`#2563eb`, not `--accent`) |

`text-neutral-600` (`#525252`) on the dark background (`#0f0f12`) is roughly
**2.5:1**, under the 4.5:1 AA floor for body text — a legibility bug, and a
light `#d4d4d4` input border sitting on near-black. This is why the surface
was worth touching even with no Close reference to match.

## What changed
- Every raw palette class → tokens: `Field` + `controlBase`/`controlBorder`
  for inputs, `Button` for actions, `--accent` for the progress bar,
  `--danger`/`--danger-subtle` for errors.
- Mapping-review table → the PR-B DataTable treatment (41px bold header row,
  40px rows, ruled cells), replacing an uppercase `text-xs` head.
- Each page rendered a **second `<h1>`** under AppShell's; all three now
  contribute headings, as `/queue` does. See `12-queue.md`.
- Progress bar gains `role="progressbar"` with real `aria-valuenow`.

## Verified after
Label flips `#5e5e5e` → `#a1a1aa`; input flips border `#e2e2e2` → `#27272d`,
fill `#ffffff` → `#17171b`, text `#2e2e2e` → `#f4f4f5`. Submit button is
`rgb(43,108,240)` = `--accent`, radius 8px, height 32px — Close's primary.
Headings: one `H1` (top bar) + one `H2`.

> The dark-mode read has to be taken **after a ~400ms settle**. `controlBase`
> carries `transition-colors`, and reading it immediately after the theme flip
> returns the outgoing colour — the trap already logged in `README.md`, which
> would have produced a false "still broken" finding here.

## Explicitly NOT touched
The import flow, its API calls, the duplicate/merge strategy, and the
`data-testid="view-leads"` hook the e2e suite depends on are unchanged.

## Brief 45 (PR F): uploads go into a list
- `/imports` opens with **"Where should these people go?"**: an existing list
  (a native `<select>` grouped by folder with `<optgroup>`, archived lists left
  out) or a new list (name, and a folder or "No folder"). Native selects
  because the kit's `Select` has no groups; styled with `controlBase` like the
  page's other inputs. The choice is checked (`POST /api/imports/destination`)
  before the file is sent, with the lists API's own words.
- The mapping-review step is unchanged.
- The progress page adds a summary card under a finished import ("412 rows →
  380 new people, 32 already in your CRM (added to this list too)", the list,
  then "Ranked: done" / "Scoring the 380 new people…" / the morning fallback)
  and an **Open the list** button beside `view-leads`.
