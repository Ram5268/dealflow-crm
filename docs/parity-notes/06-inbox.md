# Inbox parity delta

Close references: `reference/close/06-inbox-emails.png`, `06b-inbox-calls.png`,
`03-focus-tasks-inbox.png`, plus Close's per-lead activity timeline in
`05-lead-detail.png`.

## Shape is an intentional divergence (brief §5.6)
DealFlow's Inbox is a **three-pane unified surface** — filter rail, thread list,
reading pane — carrying email + SMS + voicemail in one place. Close has no
equivalent: its inbox is a full-width single-pane task list, and per-conversation
reading happens on the lead. **The shape was preserved.** Per planner direction,
the row *style* was matched to Close's activity/message rows instead.

## What Close does
- Message and activity text is **14px**; timestamps sit right-aligned at 13–14px.
- Filter chips are **24px tall, 13px / 400, radius 8, padding `4px 8px`**, with
  the active chip filled **`#e2e2e2`** and the rest transparent.
- Activity rows are ~35px inside a `#f9f9f9` grouping strip padded `12px 24px`.

## What DealFlow currently did
- Row text 13px, preview line 11px, timestamps 11px — a full step smaller than
  Close throughout, which made the list read lighter and more "webby".
- Filter chips `rounded-md px-2 py-1 text-xs font-medium`, active fill
  `--bg-active` (`#f1f1f1`).

## Meaningful delta (priority order)
1. **[HIGH]** Row typography one step small everywhere → sender/subject 14px,
   preview and timestamp 13px.
2. **[MED]** Filter chips: 11px/500 on `#f1f1f1` → Close's 24px, 13px/400 on
   `#e2e2e2`.

## Preserved deliberately
- Three-pane layout, the unread dot, and `j`/`k` keyboard model — all DealFlow
  behaviours with no Close counterpart.
- Preview line stays 13px rather than Close's 14px: the list pane is 379px wide
  against Close's full-width row, so 14px preview truncates materially sooner.
  Noted as a considered divergence, not an oversight.
