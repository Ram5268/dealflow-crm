# Queue chrome parity delta

Close reference: none captured — see below.
DealFlow before: `reference/dealflow/12-queue-before.png`;
after: `reference/dealflow/12-queue-after.png`.

## Reference note
Close's nearest analogue to `/queue` is a **Lead Smart View**, which was
already measured in PR-B (`reference/close/04-leads-list.png`) — it is the same
list surface with a different filter. Rather than re-capture it, this surface
was matched against the **DataTable treatment PR-B derived from it** and the
inbox chip treatment from PR-C, so the queue is consistent with the two
surfaces Ryan has already accepted.

## Defect found (not a parity gap)
`/queue` rendered a **second `<h1>`** — "Call Queue (preview)" — underneath the
"Call Queue" that AppShell's top bar already draws. Two visible titles, and
two `h1`s on one page for a screen reader. `/imports` and both of its
sub-pages had the same shape.

Measured: `H1 "Call Queue" @13px/600 (in top bar)` **and**
`H1 "Call Queue (preview)" @16px/600 (in page body)`.

The fix follows PR-D's settings pattern — the page contributes a **heading**,
not a competing `h1` — and "(preview)" moves into a blurb so the meaning
survives the demotion.

## Meaningful delta (priority order)
1. **[HIGH]** Duplicate `<h1>` → single heading + blurb.
2. **[HIGH]** Table → the PR-B treatment: 41px bold header row on `--bg`,
   40px body rows, ruled cells, no outer radius or rounded frame.
3. **[MED]** Header row was `text-xs uppercase` — Close's table heads are
   **14px/700 and not uppercase** (measured in PR-B).
4. **[MED]** View chips → PR-C's inbox chip (24px, `--border` fill when active)
   instead of a bordered `accent-subtle` pill.
5. **[LOW]** Row links `text-accent` → `--link`; body copy 13 → 14px.
6. **[LOW]** Centred `max-w-4xl` column dropped, as on sequences/templates.

## Explicitly NOT touched
Every compliance-derived string is passed through byte-identical — the
`excludedCompliance` and `excludedNoPhone` counts and `queue.staleReason` are
the same expressions, rendered at a different type size. **No calling-window
text is fabricated and no REASON_CODE was altered**; the page still renders
whatever `getQueue` returns. Queue ranking, exclusion and staleness logic is
untouched.
