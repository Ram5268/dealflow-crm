-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "source" TEXT,
    "statusId" TEXT,
    "statusLabel" TEXT,
    "url" TEXT,
    "addresses" JSONB NOT NULL DEFAULT '[]',
    "primaryAddressFull" TEXT,
    "primaryAddressSummary" TEXT,
    "timezone" TEXT,
    "localtime" TEXT,
    "priorityScore" INTEGER,
    "topMatchFit" INTEGER,
    "captureStatus" TEXT,
    "matchReason" TEXT,
    "dealflowDeepLink" TEXT,
    "mojoId" TEXT,
    "dealflowSignalSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "timezone" TEXT,
    "timezoneSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPhone" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneFormatted" TEXT,
    "type" TEXT NOT NULL,
    "country" TEXT,
    "outboundSmsBlocked" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "lineType" TEXT,
    "lineTypeVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEmail" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isUnsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContactEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactUrl" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "ContactUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT,
    "pipelineId" TEXT,
    "statusId" TEXT,
    "statusLabel" TEXT,
    "statusType" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "value" INTEGER,
    "valuePeriod" TEXT NOT NULL DEFAULT 'one_time',
    "valueCurrency" TEXT NOT NULL DEFAULT 'USD',
    "note" TEXT,
    "dateWon" TIMESTAMP(3),
    "dateLost" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "isDateless" BOOLEAN NOT NULL DEFAULT false,
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "activityAt" TIMESTAMP(3) NOT NULL,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "callId" TEXT,
    "messageId" TEXT,
    "taskId" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL DEFAULT 'cf_' || substr(md5(random()::text), 1, 24),
    "organizationId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "acceptsMultipleValues" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "valueText" TEXT,
    "valueNumber" DOUBLE PRECISION,
    "valueDate" TIMESTAMP(3),
    "valueJson" JSONB,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL DEFAULT 'save_' || substr(md5(random()::text), 1, 24),
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "sQuery" JSONB NOT NULL,
    "selectedFields" JSONB NOT NULL DEFAULT '[]',
    "sort" JSONB NOT NULL DEFAULT '[]',
    "resultsLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomActivityType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "namePlural" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomActivityType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mappingJson" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "errorLog" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealFlowDerivedSignal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mojoId" TEXT NOT NULL,
    "queueRank" INTEGER,
    "priorityScore" INTEGER,
    "queueReason" TEXT,
    "primaryMatchId" TEXT,
    "primaryMatchFit" INTEGER,
    "primaryCaptureStatus" TEXT,
    "primaryMatchConfidence" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dealflowRawJson" JSONB NOT NULL,

    CONSTRAINT "DealFlowDerivedSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DialSession" (
    "id" TEXT NOT NULL DEFAULT 'dial_' || substr(md5(random()::text), 1, 24),
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceValue" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 1,
    "maxLineCount" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'active',
    "callerId" TEXT NOT NULL,
    "ringTimeoutSec" INTEGER NOT NULL DEFAULT 19,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "DialSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL DEFAULT 'call_' || substr(md5(random()::text), 1, 24),
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "leadId" TEXT,
    "contactId" TEXT,
    "dialSessionId" TEXT,
    "direction" TEXT NOT NULL,
    "callMethod" TEXT NOT NULL,
    "disposition" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "source" TEXT NOT NULL DEFAULT 'Close.io',
    "localPhone" TEXT NOT NULL,
    "remotePhone" TEXT NOT NULL,
    "duration" INTEGER,
    "cost" DECIMAL(10,4),
    "providerCallSid" TEXT NOT NULL,
    "providerStatusCallback" TEXT,
    "recordingUrl" TEXT,
    "recordingDurationSec" INTEGER,
    "voicemailUrl" TEXT,
    "voicemailDurationSec" INTEGER,
    "outcomeId" TEXT,
    "noteHtml" TEXT,
    "activityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emittedAt" TIMESTAMP(3),

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLeg" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "contactPhoneId" TEXT NOT NULL,
    "providerLegSid" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "amdResult" TEXT,
    "amdConfidence" DOUBLE PRECISION,
    "disposition" TEXT,
    "droppedLoserMessage" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CallLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PacingMetric" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dialSessionId" TEXT,
    "minuteBucket" TIMESTAMP(3) NOT NULL,
    "dialsInitiated" INTEGER NOT NULL DEFAULT 0,
    "humansReached" INTEGER NOT NULL DEFAULT 0,
    "amdMachineHang" INTEGER NOT NULL DEFAULT 0,
    "abandonedCalls" INTEGER NOT NULL DEFAULT 0,
    "amdFalsePositive" INTEGER NOT NULL DEFAULT 0,
    "currentLineCount" INTEGER,

    CONSTRAINT "PacingMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DncSuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT,
    "reason" TEXT,

    CONSTRAINT "DncSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LitigatorSuppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "vendorMatchId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LitigatorSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MobileLineCache" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "lineType" TEXT NOT NULL,
    "carrier" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileLineCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallingWindowConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "earliestHour" INTEGER NOT NULL DEFAULT 9,
    "latestHour" INTEGER NOT NULL DEFAULT 20,
    "allowedDaysOfWeek" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "policyConfirmedBy" TEXT,
    "policyConfirmedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallingWindowConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HolidaySuppressionDate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolidaySuppressionDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrubLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactPhoneId" TEXT,
    "operation" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "detail" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScrubLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkScrubCheckpoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "importBatchId" TEXT,
    "lastProcessedPhone" TEXT,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkScrubCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "userId" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerDeliveryState" TEXT,
    "threadId" TEXT,
    "fromAddress" TEXT NOT NULL,
    "toAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bccAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "smsRemotePhone" TEXT,
    "smsLocalPhone" TEXT,
    "templateId" TEXT,
    "sequenceId" TEXT,
    "sequenceEnrollmentId" TEXT,
    "providerMessageId" TEXT,
    "cost" DECIMAL(10,4),
    "errorMessage" TEXT,
    "dateScheduled" TIMESTAMP(3),
    "dateSent" TIMESTAMP(3),
    "activityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateCreated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "subject" TEXT NOT NULL,
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "providerThreadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "mergeFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channel" TEXT NOT NULL,
    "blackoutDates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "delayHours" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceEnrollment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentStepId" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SequenceEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_mojoId_key" ON "Lead"("mojoId");

-- CreateIndex
CREATE INDEX "Lead_organizationId_idx" ON "Lead"("organizationId");

-- CreateIndex
CREATE INDEX "Lead_organizationId_priorityScore_idx" ON "Lead"("organizationId", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "Lead_organizationId_statusId_idx" ON "Lead"("organizationId", "statusId");

-- CreateIndex
CREATE INDEX "Lead_mojoId_idx" ON "Lead"("mojoId");

-- CreateIndex
CREATE INDEX "Contact_organizationId_idx" ON "Contact"("organizationId");

-- CreateIndex
CREATE INDEX "Contact_leadId_idx" ON "Contact"("leadId");

-- CreateIndex
CREATE INDEX "ContactPhone_contactId_idx" ON "ContactPhone"("contactId");

-- CreateIndex
CREATE INDEX "ContactPhone_phone_idx" ON "ContactPhone"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPhone_contactId_phone_key" ON "ContactPhone"("contactId", "phone");

-- CreateIndex
CREATE INDEX "ContactEmail_contactId_idx" ON "ContactEmail"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEmail_contactId_email_key" ON "ContactEmail"("contactId", "email");

-- CreateIndex
CREATE INDEX "ContactUrl_contactId_idx" ON "ContactUrl"("contactId");

-- CreateIndex
CREATE INDEX "Opportunity_organizationId_idx" ON "Opportunity"("organizationId");

-- CreateIndex
CREATE INDEX "Opportunity_leadId_idx" ON "Opportunity"("leadId");

-- CreateIndex
CREATE INDEX "Task_organizationId_idx" ON "Task"("organizationId");

-- CreateIndex
CREATE INDEX "Task_assignedToId_isComplete_dueDate_idx" ON "Task"("assignedToId", "isComplete", "dueDate");

-- CreateIndex
CREATE INDEX "Activity_organizationId_activityAt_idx" ON "Activity"("organizationId", "activityAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_leadId_activityAt_idx" ON "Activity"("leadId", "activityAt" DESC);

-- CreateIndex
CREATE INDEX "Activity_contactId_activityAt_idx" ON "Activity"("contactId", "activityAt" DESC);

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_organizationId_objectType_displayOrde_idx" ON "CustomFieldDefinition"("organizationId", "objectType", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_organizationId_objectType_name_key" ON "CustomFieldDefinition"("organizationId", "objectType", "name");

-- CreateIndex
CREATE INDEX "CustomFieldValue_organizationId_objectType_objectId_idx" ON "CustomFieldValue"("organizationId", "objectType", "objectId");

-- CreateIndex
CREATE INDEX "CustomFieldValue_definitionId_idx" ON "CustomFieldValue"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldValue_definitionId_objectId_key" ON "CustomFieldValue"("definitionId", "objectId");

-- CreateIndex
CREATE INDEX "SavedView_organizationId_type_idx" ON "SavedView"("organizationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CustomActivityType_organizationId_name_key" ON "CustomActivityType"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Attachment_organizationId_idx" ON "Attachment"("organizationId");

-- CreateIndex
CREATE INDEX "ImportBatch_organizationId_createdAt_idx" ON "ImportBatch"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DealFlowDerivedSignal_mojoId_key" ON "DealFlowDerivedSignal"("mojoId");

-- CreateIndex
CREATE INDEX "DealFlowDerivedSignal_organizationId_priorityScore_idx" ON "DealFlowDerivedSignal"("organizationId", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "DealFlowDerivedSignal_syncedAt_idx" ON "DealFlowDerivedSignal"("syncedAt");

-- CreateIndex
CREATE INDEX "DialSession_organizationId_startedAt_idx" ON "DialSession"("organizationId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Call_providerCallSid_key" ON "Call"("providerCallSid");

-- CreateIndex
CREATE INDEX "Call_organizationId_activityAt_idx" ON "Call"("organizationId", "activityAt" DESC);

-- CreateIndex
CREATE INDEX "Call_dialSessionId_idx" ON "Call"("dialSessionId");

-- CreateIndex
CREATE INDEX "Call_providerCallSid_idx" ON "Call"("providerCallSid");

-- CreateIndex
CREATE INDEX "CallLeg_callId_idx" ON "CallLeg"("callId");

-- CreateIndex
CREATE INDEX "CallLeg_providerLegSid_idx" ON "CallLeg"("providerLegSid");

-- CreateIndex
CREATE INDEX "PacingMetric_organizationId_minuteBucket_idx" ON "PacingMetric"("organizationId", "minuteBucket" DESC);

-- CreateIndex
CREATE INDEX "PacingMetric_dialSessionId_minuteBucket_idx" ON "PacingMetric"("dialSessionId", "minuteBucket" DESC);

-- CreateIndex
CREATE INDEX "DncSuppression_organizationId_phone_idx" ON "DncSuppression"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "DncSuppression_organizationId_phone_source_key" ON "DncSuppression"("organizationId", "phone", "source");

-- CreateIndex
CREATE INDEX "LitigatorSuppression_organizationId_phone_idx" ON "LitigatorSuppression"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "LitigatorSuppression_organizationId_phone_vendor_key" ON "LitigatorSuppression"("organizationId", "phone", "vendor");

-- CreateIndex
CREATE INDEX "MobileLineCache_expiresAt_idx" ON "MobileLineCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileLineCache_organizationId_phone_key" ON "MobileLineCache"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "CallingWindowConfig_organizationId_timezone_key" ON "CallingWindowConfig"("organizationId", "timezone");

-- CreateIndex
CREATE INDEX "HolidaySuppressionDate_organizationId_date_idx" ON "HolidaySuppressionDate"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "HolidaySuppressionDate_organizationId_date_scope_key" ON "HolidaySuppressionDate"("organizationId", "date", "scope");

-- CreateIndex
CREATE INDEX "ScrubLog_organizationId_checkedAt_idx" ON "ScrubLog"("organizationId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "ScrubLog_phone_idx" ON "ScrubLog"("phone");

-- CreateIndex
CREATE INDEX "BulkScrubCheckpoint_organizationId_importBatchId_idx" ON "BulkScrubCheckpoint"("organizationId", "importBatchId");

-- CreateIndex
CREATE INDEX "OAuthCredential_organizationId_idx" ON "OAuthCredential"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCredential_organizationId_provider_key" ON "OAuthCredential"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message"("providerMessageId");

-- CreateIndex
CREATE INDEX "Message_organizationId_activityAt_idx" ON "Message"("organizationId", "activityAt" DESC);

-- CreateIndex
CREATE INDEX "Message_threadId_idx" ON "Message"("threadId");

-- CreateIndex
CREATE INDEX "Message_providerMessageId_idx" ON "Message"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailThread_providerThreadId_key" ON "EmailThread"("providerThreadId");

-- CreateIndex
CREATE INDEX "EmailThread_organizationId_lastMessageAt_idx" ON "EmailThread"("organizationId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "MessageTemplate_organizationId_channel_idx" ON "MessageTemplate"("organizationId", "channel");

-- CreateIndex
CREATE INDEX "Sequence_organizationId_idx" ON "Sequence"("organizationId");

-- CreateIndex
CREATE INDEX "SequenceStep_sequenceId_ordinal_idx" ON "SequenceStep"("sequenceId", "ordinal");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_organizationId_status_idx" ON "SequenceEnrollment"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_contactId_status_idx" ON "SequenceEnrollment"("contactId", "status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPhone" ADD CONSTRAINT "ContactPhone_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEmail" ADD CONSTRAINT "ContactEmail_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactUrl" ADD CONSTRAINT "ContactUrl_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "CustomFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "cfv_lead_fk" FOREIGN KEY ("objectId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DialSession" ADD CONSTRAINT "DialSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DialSession" ADD CONSTRAINT "DialSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_dialSessionId_fkey" FOREIGN KEY ("dialSessionId") REFERENCES "DialSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLeg" ADD CONSTRAINT "CallLeg_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrubLog" ADD CONSTRAINT "ScrubLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthCredential" ADD CONSTRAINT "OAuthCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
