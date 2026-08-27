-- AlterTable
ALTER TABLE "OAuthCredential" ADD COLUMN     "emailAddress" TEXT,
ADD COLUMN     "gmailHistoryId" TEXT,
ADD COLUMN     "gmailWatchExpiresAt" TIMESTAMP(3),
ADD COLUMN     "graphDeltaLink" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

