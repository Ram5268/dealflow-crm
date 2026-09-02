# Settings sub-pages parity delta

Close references (note the **corrected** routes — brief §5.9's are stale, see
`close-measurements.md`):

| DealFlow | Close |
|---|---|
| `/settings/profile` | `/settings/` — `reference/close/09a-settings-profile.png` |
| `/settings/connected-accounts` | `/settings/accounts-and-apps/connected-accounts/` — `09b-…png` |
| `/settings/calling` | `/settings/phone/` — `09c-settings-phone-voicemail.png` |
| `/settings/compliance` | **no Close equivalent** — compared against the calling-window screens |
| `/settings/usage` | `/settings/billing/usage/` — `09d-settings-usage.png` |

Duplicate-size check run on both the Close refs and all ten DealFlow captures:
all distinct, so none of these is an empty shell.

## What Close does
- Settings rail is **260px**, rows **28px**, 13px. The active section is marked
  by **colour and weight only** — `#245bc6` at **600**, **no background fill**
  and no left bar. Inactive rows are `#5e5e5e` at 400.
- Rail is grouped under **11px / 600 UPPERCASE** labels with `0.25px`
  letter-spacing (General · Organization · Customization · Communication ·
  Connect).
- Page heading **24px / 700** `#2e2e2e`; card titles 14px/600.
- Cards: white, `8px` radius, `1px #e2e2e2`.

## What DealFlow currently did
- Rail 208px (`sm:w-52`), rows 31px, active drawn as a **filled `#eef3fd` pill
  with a 2px left accent bar** — a different marking language from Close's.
- Page heading **14px / 600**; blurb 11px. Card titles 13px/500.
- Cards already white / `8px` / `1px #e2e2e2` (inherited from the PR-B
  `--radius-lg` fix) — no change needed.

## Meaningful delta (priority order)
1. **[HIGH]** Page heading 14/600 → **24/700**. Settings pages read as a small
   sub-panel rather than a page in their own right.
2. **[HIGH]** Rail active state: filled pill + left bar → **`#245bc6` at 600, no
   fill**. Close never fills a settings rail row.
3. **[MED]** Rail width 208 → **260px**; rows 31 → **28px**; inactive → `#5e5e5e`
   at 400.
4. **[MED]** Blurb 11px → 14px; card titles 13px/500 → 14px/600.

## Verified after
All five pages: heading **24px/700** · rail **260px** · active row **28px,
`rgb(36,91,198)`, weight 600, transparent** · inactive **28px, `rgb(94,94,94)`,
weight 400** — equal to Close.

Pleasing confirmation: Close's active-rail blue is `#245bc6`, byte-identical to
the `--link` token added in PR-B for leads-grid row links. Close uses one link
blue throughout; we now do too, so no new token was needed.

## Intentional divergence (do NOT match)
- **No uppercase group headers in the rail.** Close groups 25+ settings screens
  under five headings; we have five screens total, so grouping would add
  chrome without adding navigation. Structural, not polish — flag if wanted.
- **Compliance has no Close analogue.** Close has no DNC/litigator/calling-window
  settings screen. Only the shared page chrome (heading, rail, card treatment)
  was matched. **No compliance copy, verdict or REASON_CODE was touched** —
  §6 and `project_ui_must_render_actual_state` both forbid it, and the page
  still renders whatever the compliance lib returns. The M5 e2e test
  "compliance states the real calling-window verdict, not a hardcoded window"
  guards this and passes.
- **Profile stays read-only.** Close's profile is editable; ours has no auth or
  profile model to write to (M5 §4). Untouched.
