# Focus parity delta

Close reference: `reference/close/03-focus-tasks-inbox.png` (Close's nearest
analogue is the tabbed task inbox).

## What Close does
- Page ground `#f9f9f9`; content panels white with `8px` radius and `1px #e2e2e2`.
- Small section labels are **12px / 500**, sentence case, `#5e5e5e` — Close
  reserves 11px UPPERCASE for the sidebar's PINNED rail only.
- Primary CTA is a solid **`#2b6cf0`** button, 30px tall, radius 8, 14px/500.
- Dense: no large empty padding blocks; the list starts immediately under tabs.

## What DealFlow currently does
- Four stat panels + a "Needs attention" list. Panels were `10px` radius.
- "Needs attention" label was 11px/500.
- Primary CTA ("Start dialing") used `--accent` `#2a6bd8`.

## Meaningful delta (priority order)
1. **[HIGH]** `--accent` `#2a6bd8` vs Close `#2b6cf0` — every primary CTA in the
   app is off-hue. Token fix; planner-approved.
2. **[MED]** Panel radius 10px vs Close 8px → `--radius-lg` 10 → 8.
3. **[LOW]** Section label 11px → 12px to match Close's small-label step.

## Intentional divergence (do NOT match)
- **Shape is preserved (brief §5.3).** DealFlow's Focus is panels + a
  needs-attention list, NOT Close's tabbed task inbox. Only colour, spacing and
  type were matched. No structural change.

## Open item for a later PR
Close's small-text step is **12px**; ours (`--text-xs`) is **11px**. Bumping the
token globally would touch every surface PRs C–E have not yet reviewed, so this
PR sets 12px only at the two labels it owns. Recommend a global `--text-xs`
decision at PR-E once every surface has been compared.
