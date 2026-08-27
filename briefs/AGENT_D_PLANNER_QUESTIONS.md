# Agent D → Planner: contract questions (route to Ryan)

Per Brief §14 (contract-change protocol) + kickoff rule #4 (contract mismatch → STOP,
route to Ryan). One is **blocking Milestone 2**; the rest are low-stakes confirmations
I've already resolved in D's favor and am proceeding on. Nothing here changes another
slice's semantics — all touch Agent-D-owned surfaces only.

---

## Q1 — BLOCKING (M2.1): frozen `OAuthCredential` is missing the fields M2/M5 need

The planner folded `OAuthCredential` into the frozen schema (good — resolves Blocking
Issue B.2's "bless the addition"). **But the folded-in shape is the minimal version and
is missing the columns the sync milestones actually run on.**

Frozen shape today:
```prisma
model OAuthCredential {
  id, organizationId, userId?, provider,
  accessTokenEncrypted String, refreshTokenEncrypted String?,
  scope String?, expiresAt DateTime?, createdAt, updatedAt
  @@unique([organizationId, provider])
}
```

Columns the milestones require that don't exist:
| Missing column | Needed by | Why it can't be worked around |
|---|---|---|
| `gmailHistoryId String?` | M2.2 delta sync | delta cursor — nowhere else to persist it; brief forbids local workarounds |
| `graphDeltaLink String?` | M5 Graph delta sync | `@odata.deltaLink` cursor — same |
| `gmailWatchExpiresAt DateTime?` | M2.4/2.5 watch renewal | Gmail push subs expire in 7d; need to know when to renew |
| `status String @default("active")` | failure-mode table, cron skip, "Reconnect" UX | `active\|reauth_required\|error` — drives whether sync skips a dead credential |
| `emailAddress String?` | M2.4 push routing | Gmail Pub/Sub envelope identifies the account by email; without it I can't map a push to a credential |

**Recommended resolution (additive, zero blast radius — no other agent reads this table):**
add the five nullable columns above to the frozen `OAuthCredential`. My
`comms-oauth-credentials` migration then just runs additively.

Two sub-decisions:
- **Encryption shape — NO schema change needed.** Brief §7 wanted a GCM
  `ciphertext/iv/tag` triple; frozen has a single `refreshTokenEncrypted`. I'll pack
  `base64(iv).base64(tag).base64(ciphertext)` into the single column — AES-256-GCM works
  fine, just adapt `crypto.ts`. **Proceeding on this; no planner action.**
- **Unique key.** Frozen `@@unique([organizationId, provider])` allows exactly one Gmail
  + one Outlook per org. For single-seat MVP that's correct — recommend **keep as-is**,
  store `emailAddress` as a non-key attribute (for push-target validation only). Only
  widen to `[organizationId, provider, emailAddress]` if Ryan wants multiple accounts
  per provider (not needed for MVP).

**What's blocked until you bless this:** `oauth/store.ts`, `oauth/gmail.ts`,
`gmail-sync.ts` delta path (they write columns that must exist in the generated Prisma
client). Everything else in M3 (templates + sequences, email-only) is un-blocked and I'm
building it now.

---

## Q2 — CONFIRM (non-blocking): REASON_CODES vocabulary

`contracts/http/reason-codes.ts` publishes the central enum (resolves the "publish
REASON_CODES centrally" ask). It differs from the brief's *assumed working set*:

| Brief assumed | Frozen enum has | D's plan |
|---|---|---|
| `compliance_unavailable` (fail-closed) | `vendor_error` | fail-closed emits **`vendor_error`** |
| `holiday_suppressed` | `holiday_federal` / `holiday_state` | mock emits whichever C sends; D doesn't synthesize holidays |
| `mobile_line_unverified` | (none) | not D's concern (C's line check) |
| `internal_dnc` | `internal_dnc` ✅ | Gate-3 path #5 uses this |

**Proceeding** treating frozen `reason-codes.ts` as authoritative. Flag if you want a
different fail-closed code than `vendor_error`.

---

## Q3 — FYI (non-blocking): resolved-by-scaffold items

- **B.3 (Message.status delivery states) = RESOLVED as option (b).** Frozen `Message`
  already has `providerDeliveryState String?`. I keep `status` coarse
  (`outbox|sent|error`) and write raw Twilio state to `providerDeliveryState`. No action.
- **B.1 (dnc/internal) = HTTP path.** Proceeding; client wrapper tolerates merged
  `{id,phone,source,addedAt,added}` and legacy subset. No action.
- **`CONTRACTS.md` doesn't exist** in the repo (brief references it repeatedly). The
  `contracts/` directory is the real source of truth and is present, so this isn't
  blocking — but if you intended a top-level `CONTRACTS.md`, it's missing. FYI only.
