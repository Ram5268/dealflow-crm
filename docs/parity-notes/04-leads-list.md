# Leads list parity delta

Close reference: `reference/close/04-leads-list.png`. All values via
`getComputedStyle` at 1440x900.

## What Close does
- Grid is **edge to edge**: table starts at x=252 (immediately right of the
  sidebar) and spans the full 1188px content column. No card, no inset, no
  outer radius.
- Header band is **`#f9f9f9`** — the page ground, not the card white — 41px
  tall, **14px / 700** `#2e2e2e`, sentence case, `1px #e2e2e2` on the bottom
  and between every column.
- Body rows are white, **40–41px**, 14px text, with `1px #e2e2e2` **vertical
  column rules**. Row separation comes from the cells, not the `<tr>`.
- The lead name is a link in **`#245bc6`** at weight 400 — a deeper blue than
  Close's `#2b6cf0` primary button. Close does not reuse the button colour.
- Status renders as a fully-rounded 22px pill on `#e2e2e2`.

## What DealFlow currently does (before)
- Table floated in a white card: `10px` radius, `1px #e2e2e2`, inset by 16px
  page padding — x=268, w=1156.
- Header 32px, **11px / 500** `#767676`, no column rules, no bottom rule.
- Rows 44px, 13px text, no column rules.
- Name was `#2e2e2e` weight 500 — indistinguishable from ordinary cell text.
- Status was a `4px`-radius rounded rect.

## Meaningful delta (priority order)
1. **[HIGH]** Card-inset table vs Close's full-bleed grid. → drop the card
   chrome from `DataTable`, drop the page's `p-4`.
2. **[HIGH]** Header type 11/500 muted vs Close 14/700 near-black on a `#f9f9f9`
   band — the single biggest reason our table did not read like Close's.
3. **[HIGH]** No column rules. Close rules every column and the header bottom.
4. **[MED]** Row height 44 → 40; cell text 13 → 14.
5. **[MED]** Name link `#2e2e2e`/500 → `#245bc6`/400 (new `--link` token).
6. **[MED]** Status chip → 22px pill, `#e2e2e2`, radius 50px, 13px/400.

## Verified after
`th` 41px · 14px/700 · `#2e2e2e` · thead `#f9f9f9` · column rule `1px #e2e2e2` ·
row 40px · cell 14px · link `rgb(36,91,198)` weight 400 · table x=252 w=1188 —
every value equal to Close.

## Intentional divergence (do NOT match)
- **Our columns stay.** Priority / Contacts / Source / Updated are DealFlow's
  dial-queue signal and have no Close counterpart. Only the *treatment* was
  matched, not the column set.
- **No "+ Calculation" footer row.** Close-only aggregation feature.

## Blast radius
`DataTable` is consumed by exactly two callers — `LeadsView` and the `/_dev`
primitives catalog — so this restyle cannot reach Sequences or Templates.
