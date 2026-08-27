-- S1 (§13, Agent B): one CallLeg row per (call, provider leg SID).
-- Backs the two-legs race resolver — a re-delivered Twilio webhook can no longer
-- double-insert a leg. Additive; the Call/CallLeg tables were created in
-- 20260827045415_initial.

-- CreateIndex
CREATE UNIQUE INDEX "CallLeg_callId_providerLegSid_key" ON "CallLeg"("callId", "providerLegSid");
