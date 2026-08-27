-- AlterTable
ALTER TABLE "Call" ALTER COLUMN "id" SET DEFAULT 'call_' || substr(md5(random()::text), 1, 24);

-- AlterTable
ALTER TABLE "CustomFieldDefinition" ALTER COLUMN "id" SET DEFAULT 'cf_' || substr(md5(random()::text), 1, 24);

-- AlterTable
ALTER TABLE "DialSession" ALTER COLUMN "id" SET DEFAULT 'dial_' || substr(md5(random()::text), 1, 24);

-- AlterTable
ALTER TABLE "SavedView" ALTER COLUMN "id" SET DEFAULT 'save_' || substr(md5(random()::text), 1, 24);

-- CreateTable
CREATE TABLE "NotifyOverflow" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "NotifyOverflow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotifyOverflow_channel_createdAt_idx" ON "NotifyOverflow"("channel", "createdAt");
