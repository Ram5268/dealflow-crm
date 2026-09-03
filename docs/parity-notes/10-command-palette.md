# Command palette parity delta

Close reference: `reference/close/10-command-palette.png` (⌘K on `/leads/`).
DealFlow before: `reference/dealflow/10-command-palette-before.png`;
after: `reference/dealflow/10-command-palette-after.png`.

## What Close does
Measured off the live palette, not read off the screenshot:

| | Close |
|---|---|
| Panel | 674px at **20.0vh**, radius **16px**, border `1px #f1f1f1` |
| Shadow | `0 15px 25px 0 rgba(0,0,0,.15)` — single layer |
| Input | 44px, **filled `#f1f1f1`**, 14px/400, 12px padding, **no bottom rule** |
| Group heading | **11px / 600 UPPERCASE**, `#767676` |
| Row | **34px**, 14px/400, padding `7px 15px`, radius 4px |
| Row idle | `#5e5e5e` |
| Row selected | `#2e2e2e` on `rgba(0,0,0,.05)` |
| Shortcut hint | 12px/400, **bare glyphs** — no chip, border or fill |

## What DealFlow did
560px at 18vh · radius 8px · border `#e2e2e2` · a two-layer `--shadow-lg` ·
input transparent with a bottom rule at 13px · heading 11px/500 **not**
uppercase · rows 32px/13px, `#2e2e2e` whether selected or not.

## Meaningful delta (priority order)
1. **[HIGH]** Rows were the same colour selected or not — Close carries the
   selection in the text as well as the fill. Idle → `--text-muted`.
2. **[HIGH]** Panel 560 → **674px**, radius 8 → **16px**.
3. **[MED]** Input: ruled-off and transparent → **filled**, at the 14px step.
4. **[MED]** Rows 32 → 34px, 13 → 14px.
5. **[LOW]** Group heading gains 600 weight and uppercase.

## Verified after
Panel lands at **x=383 y=180, 674×… , 20.0vh, radius 16px, border
`rgb(241,241,241)`, shadow `rgba(0,0,0,.15) 0 15px 25px 0`** — every value
equal to Close. Input **44px / 14px / `rgb(241,241,241)` / no bottom border**.
Heading **11px/600 uppercase `rgb(118,118,118)`**. Rows **34px / 14px**, idle
`rgb(94,94,94)`, selected `rgb(46,46,46)`. Hint 12px.

Every colour Close draws here was **already a token from PR-A/B**: its input
fill and border are our `--bg-active` and `--border-subtle`; its idle and
selected row text are our `--text-muted` and `--text`. Nothing new was added.

## Token changes and their blast radius
- `--text-xs` **11 → 12px**. Close uses 12px for every small label; see below.
- `--text-3xl` **added at 24px** — the page/empty-state heading step measured
  in PR-D, replacing `text-[24px]` in `SettingsPanel` and `EmptyState`.
- `--radius-xl` **14 → 16px**. `rounded-xl` had **no call sites**, so this was
  a free correction; the palette is its first user.
- `--shadow-md` / `--shadow-lg` **re-measured off Close**. Blast radius:
  `--shadow-md` → `DropdownMenu`; `--shadow-lg` → `Modal`, the right-hand
  drawer, and this palette. Verified: the new-lead modal picks up
  `rgba(0,0,0,.15) 0 15px 25px 0` and keeps its 8px radius and `#e2e2e2` line.

## The one place 11px survives
A census of every element on Close under 12.5px found **11px used only for
600-weight uppercase group headings** ("COMMANDS", "PINNED"); 12px carries the
ordinary small labels and the shortcut glyphs. So the token moves to 12px and
the palette's group heading keeps 11px **explicitly**, with a comment saying
why. That is the escape hatch the PR-E brief describes, and it is the only
product surface that needs it — the other `text-xs uppercase` sites were two
table heads (replaced with the PR-B treatment) and the dev-only primitives
catalog.

## Intentional divergence (do NOT match)
- **Scrim kept.** A full-viewport tinted overlay was not detectable behind
  Close's palette, but that is a null result, not evidence of absence, so the
  `bg-black/40` scrim stays rather than be removed on weak evidence.
- **Selected-row fill stays `--bg-hover`.** Close uses `rgba(0,0,0,.05)`, which
  resolves to `#f2f2f2` on white — two units off our `#f4f4f4` — but a literal
  black alpha is invisible in dark mode. The token is theme-correct; the
  2-unit difference is not perceivable.
- **`Kbd` left alone.** Close's shortcut hints are bare 18×18 glyphs with no
  chip chrome. Our palette already renders bare text there, so it matches. The
  `Kbd` primitive (bordered, 10px) is only used by the shortcuts sheet, which
  was not measured — out of scope, not a defect.
- **Our shortcut vocabulary differs** (`g f` vs `⌘⇧L`). Content, not chrome.
