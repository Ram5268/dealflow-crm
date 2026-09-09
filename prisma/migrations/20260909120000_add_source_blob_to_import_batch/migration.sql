-- Raw import file bytes, stored on the batch when Cloudflare R2 is not
-- configured. Nullable and unindexed on purpose: written once at upload, read
-- once per commit, then nulled by the stale-blob sweep in POST /api/imports.
ALTER TABLE "ImportBatch" ADD COLUMN "sourceBlob" BYTEA;
