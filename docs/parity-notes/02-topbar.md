# Top bar parity delta

Measured live 2026-09-02 at 1440x900 via Playwright `getComputedStyle`.

## What Close does
- Top bar is **56px** tall, **`#ffffff`**, with a `1px #f1f1f1` bottom rule —
  a *lighter* line than the general `#e2e2e2` border color.
- Padding `0 16px 0 24px`. It spans only the content column (1188px at 1440
  viewport), i.e. it starts to the right of the 252px sidebar.
- Search sits left-of-centre in that column: outer box **500x42**, fill
  **`#f1f1f1`**, radius **8px**, **no border**, placeholder `#767676`,
  13-14px text, magnifier inset 36px from the left.
- Right cluster is small icon buttons (24-32px, radius 8px, transparent until
  hover) plus the yellow trial CTA. No page title lives in the bar — Close puts
  the page heading inside the content area.

## What DealFlow currently does
- 48px tall, background `--bg` (`#f7f7f8`, same as the page — so the bar does
  not read as its own surface), bottom rule `1px #e4e4e7`.
- Search launcher is 448x32, **white with a 1px border**, radius 6px — it reads
  as a form input rather than Close's filled pill.
- Left side carries the page title (`Focus`, `Leads`, …); right side has the
  bell + `New` dropdown.

## Meaningful delta (priority order)
1. **[HIGH]** Bar background is the same as the page. Close's is white, which is
   what makes the chrome read as chrome. → `bg-elevated`.
2. **[HIGH]** Search is bordered-white vs Close's borderless `#f1f1f1` fill.
   → dedicated filled treatment, drop `controlBase`/`controlBorder`.
3. **[MED]** Height 48 → 56; bottom rule → `#f1f1f1`; left pad 16 → 24.
4. **[MED]** Search 448x32 → 500x40.
5. **[LOW]** Missing `favicon.ico` — the only console error on the page
   (`404 /favicon.ico`). Close ships one; our browser tab is blank.

## Intentional divergence (do NOT match)
- **Search stays a `<button>` styled as an input.** Brief §5.2 — an `<input>`
  re-opens the Radix palette on focus restore. Visual match only.
- **The page title stays in the bar.** Close has no title here, but moving it
  into every content surface is a re-layout of all 12 surfaces, which is rework,
  not polish (§11). Preserved deliberately; planner call if Ryan wants it moved.
- **No trial/subscribe CTA.** Close-billing-only chrome.
