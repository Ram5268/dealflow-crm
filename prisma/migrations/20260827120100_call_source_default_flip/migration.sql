-- S2 (§13, Agent B): flip Call.source default from the legacy "Close.io" seed
-- value to "dealflow-crm". Newly-created calls now carry the correct provenance
-- without an explicit source on insert. Existing rows are unaffected.

-- AlterTable
ALTER TABLE "Call" ALTER COLUMN "source" SET DEFAULT 'dealflow-crm';
