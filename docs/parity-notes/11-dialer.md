# Dialer chrome parity delta

Close reference: `reference/close/11-phone-settings-popover.png`.
DealFlow before: `reference/dealflow/13-dialer-before.png`;
after: `reference/dealflow/13-dialer-after.png`.

## Reference caveat — read this before extending
Close's real analogue is its **Power Dialer**, and there is no way to see that
UI without starting a session, which dials live numbers. The standing contract
forbids it, so the Power Dialer was **not** captured and nothing here is
matched against it.

What *was* captured is Close's Phone-settings popover, reached by a button
click that dials nothing. Every "Call +1 …" control on Close was left alone.
So this note matches **panel, button and type treatment** — the vocabulary
Close uses everywhere — and makes no claim about its session bar.

## What Close does
| | Close |
|---|---|
| Primary button | `#2b6cf0`, white, radius **8px**, **32px**, 14px/500 |
| Secondary button | white, `#2e2e2e`, `1px #e2e2e2`, 8px, 32px, 14px/400 |
| Small button | 24px, 13px/400, radius 8px |
| Popover | radius 16px, `1px #e2e2e2`, `0 12px 12px -8px rgba(0,0,0,.1)` |
| Section labels | uppercase micro-headings (`PHONE SETTINGS`, `STEP 1 OF 3`) |

## What DealFlow did
Three bare `rounded-lg border p-4` boxes with no headers. Buttons were raw
class strings, not the `Button` primitive: `rounded bg-accent px-3 py-2` and
`rounded bg-accent-hover px-3 py-2` — **two filled buttons side by side**,
which Close never does. Keypad keys were flat `bg-hover` blocks. Body copy at
13px. The deep link used `text-accent underline` rather than PR-B's `--link`.

## Meaningful delta (priority order)
1. **[HIGH]** Two filled primaries → one primary, one secondary.
2. **[HIGH]** Panels gain the section-header strip the lead detail already
   uses, so the dialer stops being the only page with unlabelled boxes.
3. **[MED]** Raw button classes → the `Button` primitive, which already
   measures identical to Close.
4. **[MED]** Body copy 13 → 14px; deep link → `--link`.
5. **[LOW]** Keypad keys get the secondary treatment so they read as keys.
6. **[LOW]** Centred `max-w-4xl` column dropped, matching what PR-C did to
   sequences and templates.

## Verified after
Primary **`rgb(43,108,240)` / white / 8px / 32px**; secondary **white /
`rgb(46,46,46)` / `rgb(226,226,226)` / 8px / 32px** — equal to Close. All three
panels: 8px radius, `#e2e2e2`, `#f1f1f1` header strip at 12px/500. One `<h1>`
on the page (the top bar's), where there had been one.

## Explicitly NOT touched
**No dial, pacing, or compliance logic.** Every `onClick`, every `disabled={!onCall}`
guard, the SSE subscription and its functional-updater comment, the
`loser_twiml_unapproved` / `pacing_halted` / `spend_cap_reached` branches and
their exact strings are unchanged — this commit moves class names only. No
live call was placed from either app during this work, and neither
`SMS_ENABLED` nor `LOSER_TWIML_APPROVED` was read or written.

## Open question for the planner
Close runs button labels at **14px**; our `Button` uses `text-sm` (13px) at
every size. Since PR-B/C/D moved tables and rows to the 14px step, buttons are
now the last 13px surface. Changing it touches **every button in the app**,
all of which have already been through a merged PR, so it is left as a
planner call rather than folded in here.
