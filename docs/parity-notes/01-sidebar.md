# Sidebar parity delta

Measured live 2026-09-02 at 1440x900 via Playwright against
`app.close.com` (Douglas Elliman workspace) using `getComputedStyle`.
Every number below is read off the live DOM, not estimated from a screenshot.

## What Close does
- Sidebar is **252px** wide, **no border-right**, and **transparent** — it sits
  directly on the `#f9f9f9` body. The apparent divider is just the edge where
  the white top bar / content meets the gray sidebar.
- Nav rows are **30px** tall, `border-radius: 8px`, padding `4px 12px 4px 8px`,
  font **13px / weight 500**, icons **14px** at `stroke-width: 1`.
- Row colors: idle text `#2e2e2e`; **hover** `background:#f9f9f9` + text `#191919`;
  **active** `background:#f1f1f1` + text `#191919`. Because the sidebar already
  sits on `#f9f9f9`, Close's hover fill is effectively invisible — hover reads as
  a *text-darkening* affordance only.
- Sub-rows (Done / Future under Inbox) drop to **26px**, weight **400**, `#5e5e5e`.
- Section grouping is by `<ul>` blocks separated by whitespace + a hairline, not
  by heavy dividers. Bottom cluster: Settings / Integrations / Support.

## What DealFlow currently does
- 240px wide **with** a `1px #e4e4e7` border-right, background `--bg` `#f7f7f8`.
- Nav rows 32px, radius 6px, padding `0 8px`, 13px, icons 15px.
- Idle text `#52525b` at weight **400**; active `#e8e8ec` fill at weight 500.
  The idle rows read noticeably lighter and airier than Close's.
- Brand row is 48px, so it does not line up with the 56px Close top bar.

## Meaningful delta (priority order)
1. **[HIGH]** Active fill `#e8e8ec` is too dark and too cool vs Close `#f1f1f1`.
   → retune `--bg-active`.
2. **[HIGH]** Idle label color/weight (`#52525b`/400) vs Close (`#2e2e2e`/500).
   The whole sidebar reads washed-out next to Close. → nav rows go
   `font-medium` with `--text`; retune `--text` to Close's `#2e2e2e`.
3. **[MED]** Width 240 → 252; row height 32 → 30; radius 6 → 8; icon 15 → 14.
4. **[MED]** Border-right must go — Close has none; the color edge is the divider.
5. **[LOW]** Right padding: Close pads rows `12px` on the right so badges do not
   touch the edge. DealFlow pads `8px` symmetrically.
6. **[LOW]** Brand row 48px → 56px so it aligns with the corrected top bar.

## Intentional divergence (do NOT match)
- **User menu stays at the BOTTOM.** Close puts the profile at the top-right of
  the sidebar. Brief §5.1 pins ours to the bottom — preserved.
- **Hover keeps a visible fill.** Close's literal hover fill (`#f9f9f9` on a
  `#f9f9f9` sidebar) is invisible. Copying it byte-for-byte would delete a
  working affordance, so DealFlow keeps a subtle `--bg-hover` fill and adopts
  Close's text-darkening on top. Flagged for planner in the PR body.
- **No CHLOE / Voice Agents / Smart Views block.** Close-only features.

## Verified NOT a bug
The dark circular "N" over the bottom-left of the sidebar in
`reference/dealflow/00-global-chrome-before.png` is the **Next.js dev-tools
portal** (`<nextjs-portal>`), not a DealFlow layout fault. Measured DOM:
avatar 22x22 at x=16, label at x=46, trigger 223x40 — correct and non-overlapping.
It does not exist in a production build.
