# Close measured constants (harvested live, 2026-09-02)

Read off `app.close.com` via `getComputedStyle` at 1440x900. Kept in-repo so the
polish work in PRs B–E survives the Close trial lapsing (~2026-09-09).

## Palette

| Role | Close | DealFlow token |
|---|---|---|
| page ground | `#f9f9f9` | `--bg` ✅ matched PR-A |
| elevated / card | `#ffffff` | `--bg-elevated` ✅ |
| fill (active nav, search, secondary btn) | `#f1f1f1` | `--bg-active` ✅ |
| content border | `#e2e2e2` | `--border` ✅ |
| chrome rule (lighter) | `#f1f1f1` | `--border-subtle` ✅ |
| body text | `#2e2e2e` | `--text` ✅ |
| emphasis text | `#191919` | `--text-strong` ✅ |
| secondary text | `#5e5e5e` | `--text-muted` ✅ |
| placeholder / tertiary | `#767676` | `--text-subtle` ✅ |
| disabled / faint | `#919191` | — |
| **primary action** | **`#2b6cf0`** | `--accent` is `#2a6bd8` ❗ **unmatched** |
| trial CTA (Close-only) | `#fccc0b` | n/a |

## Geometry

- Radius: **8px** for controls, inputs, cards and nav rows. **16px** for pill
  chips and some marketing panels. `1000px` for avatars.
- Card: `8px` radius, `1px #e2e2e2`, white. Elevated variants add
  `0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .06)`.
- Control heights: **24px** (compact/chip), **30px** (default button),
  **32px** (input / icon button), **40-42px** (search).
- Sidebar 252px, top bar 56px, top bar padding `0 16px 0 24px`.

## Buttons

| Variant | bg | color | h | radius | fs / fw |
|---|---|---|---|---|---|
| primary | `#2b6cf0` | `#ffffff` | 30px | 8px | 14px / 500 |
| secondary | `#f1f1f1` | `#5e5e5e` | 30px | 8px | 14px / 500 |
| ghost / icon | transparent | `#474747` | 24–32px | 8px | 14px / 400 |
| outlined | `#ffffff` | `#2e2e2e` | 24–32px | 8px | 13–14px / 400, `1px #e2e2e2` |

## Type scale in use

| px / weight | colour | usage |
|---|---|---|
| 24 / 700 | `#2e2e2e` | page-level heading |
| 14 / 600 | `#2e2e2e` | section heading, table `th` (700 on Leads) |
| 14 / 400 | `#2e2e2e` | body, table cells |
| 13 / 500 | `#2e2e2e` | nav rows, workspace name |
| 13 / 400 | `#5e5e5e` | secondary body, sub-nav rows |
| 12 / 500 | `#2e2e2e` | badges |
| 11 / 600 | `#5e5e5e` | UPPERCASE section labels, `letter-spacing: .25px` |
| 9 / 700 | `#ffffff` | count badge on a coloured pill |

Line-height is `16px` for 11–13px text and `20px` for 14px text.

## Lists / tables

- Leads table rows **40–41px**, 14px text, white; separation comes from the
  cells, not `tr` (row `border-bottom` computes to `0px`).
- `th`: 14px / **700**, `#2e2e2e`, no uppercase, no letter-spacing, 41px tall.
- Sidebar nav rows 30px; sub-rows 26px.

## Notes

- `app.close.com/imports/` is **404** — Close has no top-level imports route, so
  brief §5.12 has no direct Close equivalent. Compare against our own /imports
  and Close's CSV flow inside Leads instead. Planner call if a closer analogue
  is wanted.
