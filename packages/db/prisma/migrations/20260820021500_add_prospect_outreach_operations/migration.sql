-- CreateEnum
CREATE TYPE "ProspectRelationshipTier" AS ENUM ('STANDARD', 'HIGH_VALUE', 'STRATEGIC');

-- CreateEnum
CREATE TYPE "ProspectCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProspectCampaignMemberStatus" AS ENUM ('SELECTED', 'DRAFTED', 'NEEDS_REVIEW', 'APPROVED', 'QUEUED', 'SENT', 'REPLIED', 'BOUNCED', 'SUPPRESSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProspectDraftStatus" AS ENUM ('NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'QUEUED', 'SENT');

-- CreateEnum
CREATE TYPE "ProspectSendBatchStatus" AS ENUM ('STAGED', 'APPROVED', 'QUEUED', 'PROCESSING', 'COMPLETE', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProspectSendItemStatus" AS ENUM ('STAGED', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProspectEmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ProspectEmailMessageStatus" AS ENUM ('RECEIVED', 'STAGED', 'QUEUED', 'SENT', 'DELIVERED', 'DELAYED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED');


-- AlterTable
ALTER TABLE "prospect_organizations" ADD COLUMN     "relationship_tier" "ProspectRelationshipTier" NOT NULL DEFAULT 'STANDARD';


-- CreateTable
CREATE TABLE "prospect_saved_views" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "owner_id" VARCHAR(191) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sort" JSONB NOT NULL DEFAULT '{}',
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_outreach_campaigns" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "description" TEXT,
    "status" "ProspectCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "cohort_snapshot" JSONB NOT NULL,
    "playbook_version" VARCHAR(100) NOT NULL,
    "created_by" VARCHAR(191) NOT NULL,
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_outreach_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_campaign_members" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "contact_id" TEXT,
    "status" "ProspectCampaignMemberStatus" NOT NULL DEFAULT 'SELECTED',
    "selection" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_campaign_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_outreach_drafts" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "contact_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ProspectDraftStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "to_email" VARCHAR(320) NOT NULL,
    "subject" VARCHAR(998) NOT NULL,
    "text_body" TEXT NOT NULL,
    "html_body" TEXT,
    "content_hash" CHAR(64) NOT NULL,
    "grounding_snapshot" JSONB NOT NULL,
    "escalation_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generated_by_type" "ActorType" NOT NULL,
    "generated_by_id" VARCHAR(191) NOT NULL,
    "approved_by" VARCHAR(191),
    "approved_at" TIMESTAMP(3),
    "rejected_reason" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_outreach_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_send_batches" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "status" "ProspectSendBatchStatus" NOT NULL DEFAULT 'STAGED',
    "recipient_count" INTEGER NOT NULL,
    "snapshot_hash" CHAR(64) NOT NULL,
    "created_by" VARCHAR(191) NOT NULL,
    "approved_by" VARCHAR(191),
    "approved_at" TIMESTAMP(3),
    "queued_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_reason" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_send_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_send_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "status" "ProspectSendItemStatus" NOT NULL DEFAULT 'STAGED',
    "recipient_email_snapshot" VARCHAR(320) NOT NULL,
    "subject_snapshot" VARCHAR(998) NOT NULL,
    "content_hash_snapshot" CHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(256) NOT NULL,
    "provider_message_id" VARCHAR(191),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(100),
    "last_error_message" VARCHAR(2000),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_send_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_email_threads" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "contact_id" TEXT,
    "subject" VARCHAR(998),
    "reply_token_hash" CHAR(64) NOT NULL,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_email_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_email_messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "contact_id" TEXT,
    "send_item_id" TEXT,
    "direction" "ProspectEmailDirection" NOT NULL,
    "status" "ProspectEmailMessageStatus" NOT NULL,
    "provider_message_id" VARCHAR(191),
    "internet_message_id" VARCHAR(998),
    "in_reply_to" VARCHAR(998),
    "from_address" VARCHAR(320) NOT NULL,
    "to_addresses" TEXT[],
    "subject" VARCHAR(998) NOT NULL,
    "text_body" TEXT,
    "html_body" TEXT,
    "attachment_metadata" JSONB NOT NULL DEFAULT '[]',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_email_events" (
    "id" TEXT NOT NULL,
    "send_item_id" TEXT,
    "email_message_id" TEXT,
    "provider_event_id" VARCHAR(191) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_followups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(1000),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_email_webhook_receipts" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "provider_event_id" VARCHAR(191) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "processing_error" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_email_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prospect_saved_views_owner_id_updated_at_idx" ON "prospect_saved_views"("owner_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_saved_views_owner_id_name_key" ON "prospect_saved_views"("owner_id", "name");

-- CreateIndex
CREATE INDEX "prospect_outreach_campaigns_status_updated_at_idx" ON "prospect_outreach_campaigns"("status", "updated_at");

-- CreateIndex
CREATE INDEX "prospect_campaign_members_campaign_id_status_idx" ON "prospect_campaign_members"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "prospect_campaign_members_organization_id_created_at_idx" ON "prospect_campaign_members"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_campaign_members_campaign_id_organization_id_conta_key" ON "prospect_campaign_members"("campaign_id", "organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "prospect_outreach_drafts_campaign_id_status_created_at_idx" ON "prospect_outreach_drafts"("campaign_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_outreach_drafts_member_id_version_key" ON "prospect_outreach_drafts"("member_id", "version");

-- CreateIndex
CREATE INDEX "prospect_send_batches_campaign_id_status_created_at_idx" ON "prospect_send_batches"("campaign_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_send_items_idempotency_key_key" ON "prospect_send_items"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_send_items_provider_message_id_key" ON "prospect_send_items"("provider_message_id");

-- CreateIndex
CREATE INDEX "prospect_send_items_batch_id_status_idx" ON "prospect_send_items"("batch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_send_items_batch_id_draft_id_key" ON "prospect_send_items"("batch_id", "draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_email_threads_reply_token_hash_key" ON "prospect_email_threads"("reply_token_hash");

-- CreateIndex
CREATE INDEX "prospect_email_threads_organization_id_last_message_at_idx" ON "prospect_email_threads"("organization_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_email_messages_send_item_id_key" ON "prospect_email_messages"("send_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_email_messages_provider_message_id_key" ON "prospect_email_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "prospect_email_messages_thread_id_occurred_at_idx" ON "prospect_email_messages"("thread_id", "occurred_at");

-- CreateIndex
CREATE INDEX "prospect_email_messages_organization_id_occurred_at_idx" ON "prospect_email_messages"("organization_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_email_events_provider_event_id_key" ON "prospect_email_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "prospect_email_events_send_item_id_occurred_at_idx" ON "prospect_email_events"("send_item_id", "occurred_at");

-- CreateIndex
CREATE INDEX "prospect_followups_status_due_at_idx" ON "prospect_followups"("status", "due_at");

-- CreateIndex
CREATE INDEX "prospect_followups_organization_id_created_at_idx" ON "prospect_followups"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "prospect_email_webhook_receipts_processed_at_created_at_idx" ON "prospect_email_webhook_receipts"("processed_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_email_webhook_receipts_provider_provider_event_id_key" ON "prospect_email_webhook_receipts"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "prospect_organizations_relationship_tier_archived_at_idx" ON "prospect_organizations"("relationship_tier", "archived_at");

ALTER TABLE "prospect_campaign_members" ADD CONSTRAINT "prospect_campaign_members_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "prospect_outreach_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_campaign_members" ADD CONSTRAINT "prospect_campaign_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_campaign_members" ADD CONSTRAINT "prospect_campaign_members_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_campaign_members" ADD CONSTRAINT "prospect_campaign_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_outreach_drafts" ADD CONSTRAINT "prospect_outreach_drafts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "prospect_outreach_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_outreach_drafts" ADD CONSTRAINT "prospect_outreach_drafts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "prospect_campaign_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_outreach_drafts" ADD CONSTRAINT "prospect_outreach_drafts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_outreach_drafts" ADD CONSTRAINT "prospect_outreach_drafts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_outreach_drafts" ADD CONSTRAINT "prospect_outreach_drafts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_send_batches" ADD CONSTRAINT "prospect_send_batches_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "prospect_outreach_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_send_items" ADD CONSTRAINT "prospect_send_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "prospect_send_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_send_items" ADD CONSTRAINT "prospect_send_items_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "prospect_campaign_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_send_items" ADD CONSTRAINT "prospect_send_items_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "prospect_outreach_drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_threads" ADD CONSTRAINT "prospect_email_threads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_threads" ADD CONSTRAINT "prospect_email_threads_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_threads" ADD CONSTRAINT "prospect_email_threads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_messages" ADD CONSTRAINT "prospect_email_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "prospect_email_threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_messages" ADD CONSTRAINT "prospect_email_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_messages" ADD CONSTRAINT "prospect_email_messages_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_messages" ADD CONSTRAINT "prospect_email_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_messages" ADD CONSTRAINT "prospect_email_messages_send_item_id_fkey" FOREIGN KEY ("send_item_id") REFERENCES "prospect_send_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_events" ADD CONSTRAINT "prospect_email_events_send_item_id_fkey" FOREIGN KEY ("send_item_id") REFERENCES "prospect_send_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_email_events" ADD CONSTRAINT "prospect_email_events_email_message_id_fkey" FOREIGN KEY ("email_message_id") REFERENCES "prospect_email_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_followups" ADD CONSTRAINT "prospect_followups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_followups" ADD CONSTRAINT "prospect_followups_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "prospect_opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
