# Sequences parity delta

Close reference: `reference/close/07-sequences.png` (Close's Workflows).

**Close's Workflows list is empty in Ryan's workspace**, so row treatment could
not be read off live data. The header row, filter bar, page heading, CTA and
empty state are all fully visible, and Close's table treatment is consistent
across Leads / Workflows / Templates, so the Leads-measured grid constants were
applied here.

## What Close does
- Page heading **24px / 700**, primary CTA `#2b6cf0` top-right, radius 8.
- Table is **full-bleed** — no card, no max-width centring.
- Header band `#f9f9f9`, **41px**, **14px / 700** `#2e2e2e`, `1px #e2e2e2` under
  it and between every column.
- Body rows 40–41px, 14px text, column rules.

## What DealFlow currently did
- Page centred in `mx-auto max-w-5xl` — a narrow column Close never uses.
- Table inside a `10px` rounded card with a full border.
- Header `bg-hover` (`#f4f4f4`) at **11px / 500** muted; rows 54–55px at 13px.

## Meaningful delta (priority order)
1. **[HIGH]** Header 11/500 muted → **14/700 near-black on `#f9f9f9`**, ruled.
2. **[HIGH]** `max-w-5xl` centring removed; card chrome dropped.
3. **[MED]** Rows 54px → **40px**; cell text 13px → **14px**; column rules added.

## Verified after
`th` 14px/700 `#2e2e2e` on `#f9f9f9` with `1px` rules · rows **40px** · cells
**14px** — equal to the Leads grid and to Close's measured constants.

## Known remaining gap
The grid sits at **x=268, w=1156**; Close's is **x=252, w=1188**. The last 16px
per side is this page's container padding. Closing it means restructuring the
page header/filter bar into a full-width strip the way Leads is built — that is
a layout change rather than polish, so it is **left for a planner call** rather
than done unilaterally.
