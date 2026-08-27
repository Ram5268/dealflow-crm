# Preflight Notes — deviations & decisions (for planner ratification)

Scaffold built by the preflight executor. Everything below is a place where the
executor had to deviate from a verbatim reading of the preflight brief, or make
a judgment call. **None** change slice semantics; all are flagged so the planner
can veto before the four agents build on them.

## 1. FROZEN schema — one additive back-relation added (needs ratification)
The frozen `prisma/schema.prisma` did not validate: `Organization.messages
Message[]` had no opposite relation field on `Message`, so `prisma generate`
failed (P1012). Every other org-owned model (User, Lead, Contact, DialSession,
ScrubLog, SavedView, OAuthCredential) declares the back-relation; `Message` was
the sole omission.

Fix applied (marked in-file with a `PREFLIGHT DEVIATION` comment):
```prisma
  organization Organization @relation(fields: [organizationId], references: [id])
```
Strictly additive, no column/index change, applied once on the base commit
before any agent forks. If the planner prefers a different resolution, change it
here before agents run migrations.

## 2. Prisma pinned to 6.19.3 (was unpinned → resolved to 7.x/8.0-rc)
`pnpm add @prisma/client` / `prisma` (unpinned in the brief) resolved to Prisma
7 (and an 8.0.0-rc for the CLI). Prisma 7 **removed** `url = env(...)` in the
datasource block — the exact syntax the frozen schema uses — and requires a
`prisma.config.ts` + driver adapter. Rather than modify the frozen schema, both
`prisma` and `@prisma/client` are pinned to the latest stable **6.19.3**, which
supports the schema as-frozen and the standard `prisma migrate dev` workflow all
four briefs assume. Agents should keep this pin.

## 3. typescript pinned to 5.7.3 (was unpinned → resolved to 7.0.2)
Unpinned `typescript` resolved to the 7.x native port, which violates the
`typescript@^5.7.3` peer that vitest/next/tsx expect. Pinned to **5.7.3**.

## 4. `@tailwindcss/postcss` added (not in the brief's install list)
Tailwind v4 moved its PostCSS integration out of the `tailwindcss` package. The
brief listed only `tailwindcss@^4 postcss autoprefixer`; without
`@tailwindcss/postcss` the `@import "tailwindcss"` in `globals.css` will not
build under Next 16. Added as a normal (non-slice) shell dependency.

## 5. Event contracts use a `type` discriminant on B's events (not `eventName`)
The preflight brief said "NO `eventName` field on any payload." That is honored —
no payload carries `eventName`. However the owning briefs diverge on the
`type` discriminant:
- **Agent B** (`crm_call`): `call.connected`, `call.completed`,
  `dial-session.pacing-update` **carry a `type` literal** (B's brief §7.1 / lock
  §8.3 item 4). Copied verbatim from B's brief.
- **Agents A/C/D** (`crm_lead_sync`, `crm_scrub`, `crm_message`): discriminant-free
  — channel is the routing signal. Matches each owning brief.

This is internally consistent per-channel (A's projector demuxes `crm_call` by
`type`, other channels by shape), but the cross-critic flagged the A-vs-B-vs-D
inconsistency. Left as each brief specifies; noted here so the planner is aware
the `type` field is intentionally present on B's three events only.

## 6. `message.received` filename shim
Preflight brief names the file `contracts/events/message.received.ts` (dotted);
Agent D's brief imports `contracts/events/message-received.ts` (dashed). The
dotted file is the single source of truth; a one-line re-export shim at the
dashed path unblocks D's literal import. Reconcile to one name when convenient.

## 7. Added a preflight smoke test
`contracts/tests/schemas/barrel.spec.ts` parses one valid payload per event and
checks the reason-code vocabulary. Proves the contract layer compiles and the
barrel resolves. `pnpm test` → 8 passing; `tsc --noEmit` → clean.
