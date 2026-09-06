-- BulkScrubCheckpoint: align the live table with the frozen schema.
--
-- The DB was carrying an older draft of this table. The schema is the correct
-- side: src/lib/compliance/bulk/worker.ts and checkpoint.ts read and write
-- `lastProcessedContactPhoneId`, `chunkIndex` and `haltReason`, none of which
-- existed in the database — so bulk-scrub resume was broken against the live DB
-- and only passed CI because the unit tests inject fakes.
--
-- Hand-written (never `migrate dev`, per the repo's schema-drift landmine) and
-- transcribed from `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel`.
--
-- DESTRUCTIVE-BUT-SAFE: drops `lastProcessedPhone` and `startedAt`. Verified
-- `SELECT count(*) FROM "BulkScrubCheckpoint"` = 0 before writing this, so no
-- data is lost, and `importBatchId` can take NOT NULL without a backfill.

-- DropIndex
DROP INDEX "BulkScrubCheckpoint_organizationId_importBatchId_idx";

-- AlterTable
ALTER TABLE "BulkScrubCheckpoint" DROP COLUMN "lastProcessedPhone",
DROP COLUMN "startedAt",
ADD COLUMN     "chunkIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "haltReason" TEXT,
ADD COLUMN     "lastProcessedContactPhoneId" TEXT,
ALTER COLUMN "importBatchId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "BulkScrubCheckpoint_organizationId_status_idx" ON "BulkScrubCheckpoint"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BulkScrubCheckpoint_organizationId_importBatchId_key" ON "BulkScrubCheckpoint"("organizationId", "importBatchId");
