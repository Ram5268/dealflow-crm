# Lead detail parity delta

Close reference: `reference/close/05-lead-detail.png`.

## What Close does
- Two panes: a **418px** details column, then the activity timeline.
- Section cards use a **filled `#f1f1f1` header band** — not a bottom rule —
  with **12px / 500** sentence-case labels and a count chip. Body is white,
  `8px` radius, `1px #e2e2e2`.
- Lead title is **18px / 700** `#2e2e2e`; the status sits beside it as a 22px
  `#e2e2e2` pill at radius 50px.
- Quick actions are a row of 32px white buttons, `1px #e2e2e2`, radius 8,
  **14px / 400** (Meeting · Note · Email · SMS · Call · Activity).

## What DealFlow currently does (before)
- 340px details column.
- Section headers were `11px/600` UPPERCASE `#767676` with a bottom rule.
- Title was `16px / 600`; cards `10px` radius.

## Meaningful delta (priority order)
1. **[HIGH]** Section headers: uppercase + ruled vs Close's sentence-case filled
   band. This is what made the page read as "not Close" at a glance.
2. **[MED]** Title 16/600 → 18/700.
3. **[MED]** Details column 340px → 418px.
4. **[MED]** Card radius 10 → 8 (token).
5. **[LOW]** Status chip → Close's pill.

## Intentional divergence (do NOT match)
- **Action set differs.** We ship Call / Email / Add to sequence; Close also has
  Meeting, Note, SMS. SMS especially stays absent — `SMS_ENABLED` is false and
  flipping it is out of scope (§6). Only the button *chrome* was matched.
- **No activity filter tabs / activity search.** Close has
  All · Important · Conversations · Notes & Summaries plus a search field over
  the timeline. That is a feature, not polish — **planner call (§12)** if
  wanted.
