# Templates parity delta

Close reference: `reference/close/08-templates.png`
(Close: Settings → Templates & Snippets).

**Close's template list is empty in Ryan's workspace**, so as with Sequences the
row constants come from Close's Leads grid, which is the same treatment.

## What Close does
- Heading **24px / 700**; underlined tab bar (Email · SMS · Snippets) with a
  2px active underline; filter chips `All / Private / Shared with you / Archived`
  where the active chip is a **24px `#e2e2e2` pill at 13px / 400**.
- Primary `+ New template` in `#2b6cf0`, radius 8.
- Empty state: **24px / 700** title, 14px `#5e5e5e` body, primary CTA beneath.
- Table full-bleed with the `#f9f9f9` 41px header band and column rules.

## What DealFlow currently did
- Centred `max-w-5xl`; table in a rounded card; header 11px/500 on `#f4f4f4`;
  rows 39px at 13px; chips 11px/500 with an `#f1f1f1` active fill.
- Empty state title 13px/500 with 13px body — far lighter than Close's 24/700.

## Meaningful delta (priority order)
1. **[HIGH]** Grid treatment (header band, weight, rules, 14px cells).
2. **[HIGH]** Empty state 13px/500 → **24px/700** title over 14px muted body.
   `EmptyState` is shared, so this lands on every empty surface — checked, and
   that is the intended direction for all of them.
3. **[MED]** Chips → Close's 24px `#e2e2e2` pill.
4. **[MED]** `max-w-5xl` centring and card chrome removed.

## Intentional divergence (do NOT match)
- **Templates stays in the SIDEBAR.** Close buries it in Settings behind a
  settings rail (brief §5.8). Our placement is deliberate and preserved; only
  the list and editor treatment were matched.
- **No Snippets tab.** Close-only feature.

## Known remaining gap
Same 16px container padding as Sequences — grid at x=268 vs Close's x=252.
Planner call; see `07-sequences.md`.
