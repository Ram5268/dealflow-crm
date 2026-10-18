-- Brief 45 PR A (2026-10-18): folders, lists and groups. Additive only.
-- Generated DB-free with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--                       --to-schema-datamodel prisma/schema.prisma --script
-- and read line by line: 4 nullable ImportBatch columns, 5 new tables, their
-- indexes and foreign keys. Nothing existing is dropped, altered or rewritten,
-- and none of the 4 cosmetic id defaults in docs/known-drift.md appear here.
-- Apply with `prisma migrate deploy` (never `prisma migrate dev`).

-- [engineering precaution] Give up and roll back after 5 s instead of queueing
-- behind a long transaction on "Lead", "ImportBatch" or "Organization": while
-- it waits, this transaction already holds ImportBatch exclusively and blocks
-- new Lead writes, and the server keeps waiting even if the client is killed.
-- On a timeout: `prisma migrate resolve --rolled-back <this migration>`, retry.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "dealflowScoreError" TEXT,
ADD COLUMN     "dealflowScoreTokenHash" TEXT,
ADD COLUMN     "dealflowScoredAt" TIMESTAMP(3),
ADD COLUMN     "targetListId" TEXT;

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallList" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folderId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListMembership" (
    "listId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,

    CONSTRAINT "ListMembership_pkey" PRIMARY KEY ("listId","leadId")
);

-- CreateTable
CREATE TABLE "LeadGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadGroupMembership" (
    "groupId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL,

    CONSTRAINT "LeadGroupMembership_pkey" PRIMARY KEY ("groupId","leadId")
);

-- CreateIndex
CREATE INDEX "Folder_organizationId_sortOrder_idx" ON "Folder"("organizationId", "sortOrder");

-- CreateIndex
CREATE INDEX "CallList_organizationId_folderId_sortOrder_idx" ON "CallList"("organizationId", "folderId", "sortOrder");

-- CreateIndex
CREATE INDEX "ListMembership_leadId_idx" ON "ListMembership"("leadId");

-- CreateIndex
CREATE INDEX "LeadGroup_organizationId_sortOrder_idx" ON "LeadGroup"("organizationId", "sortOrder");

-- CreateIndex
CREATE INDEX "LeadGroupMembership_leadId_idx" ON "LeadGroupMembership"("leadId");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_targetListId_fkey" FOREIGN KEY ("targetListId") REFERENCES "CallList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallList" ADD CONSTRAINT "CallList_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallList" ADD CONSTRAINT "CallList_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMembership" ADD CONSTRAINT "ListMembership_listId_fkey" FOREIGN KEY ("listId") REFERENCES "CallList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListMembership" ADD CONSTRAINT "ListMembership_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadGroup" ADD CONSTRAINT "LeadGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadGroupMembership" ADD CONSTRAINT "LeadGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "LeadGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadGroupMembership" ADD CONSTRAINT "LeadGroupMembership_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

