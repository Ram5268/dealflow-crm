-- Agent E · M0.5 · GAP 3 (planner-approved §13 amendment, 2026-08-29)
--
-- Inbox read/archive state for the unified Inbox (M3) and the sidebar unread
-- badge (§7). Both nullable: NULL = unread / unarchived, non-NULL = the moment
-- the user marked it. Purely additive — no backfill, no default, no rewrite of
-- existing rows, and no read-path change for Agent D's send pipeline.
--
-- These are deliberately NOT folded into Message.status, which is D's outbound
-- DELIVERY state (outbox | scheduled | sent).
--
-- SCOPED ON PURPOSE: `prisma migrate diff` reports additional pre-existing
-- drift between prisma/schema.prisma and the migration history (Agent C's
-- BulkScrubCheckpoint reshape, which is DESTRUCTIVE, plus four unapplied
-- `id` column defaults). That drift predates Agent E and is excluded here.
-- See docs/agent-e-audit.md §0 / the M0.5 PR body.
ALTER TABLE "Message" ADD COLUMN     "archivedAt" TIMESTAMPTZ(6),
ADD COLUMN     "readAt" TIMESTAMPTZ(6);
