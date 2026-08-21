-- Company Brain, CRM relationship intelligence, and meeting pipeline.

-- CreateEnum
CREATE TYPE "CompanyKnowledgeType" AS ENUM ('DECISION', 'STRATEGY', 'MEETING_SUMMARY', 'CLIENT_INSIGHT', 'SALES_LESSON', 'PRODUCT_RATIONALE', 'TECHNICAL_LESSON', 'POSTMORTEM', 'POLICY_CONTEXT', 'MARKET_RESEARCH', 'COMPETITOR_INSIGHT', 'COMPANY_HISTORY', 'OPERATIONAL_LESSON', 'OPEN_QUESTION', 'PRIORITY', 'COMMITMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CompanyKnowledgeSourceType" AS ENUM ('HUMAN_ENTRY', 'MEETING', 'EMAIL', 'SUPPORT_THREAD', 'AGENT_RUN', 'OPERATIONAL_EVENT', 'RESEARCH', 'SYSTEM_EVENT', 'IMPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "CompanyKnowledgeAuthority" AS ENUM ('AUTHORITATIVE_CURRENT', 'DURABLE_CONTEXT', 'HISTORICAL', 'INFERENCE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CompanyKnowledgePromotionStatus" AS ENUM ('CANDIDATE', 'PROMOTED', 'REJECTED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CompanyKnowledgeAccessScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'TENANT', 'VENUE', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "CompanyDecisionStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CompanyPriorityStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountRelationshipNoteCategory" AS ENUM ('RELATIONSHIP', 'COMMUNICATION_PREFERENCE', 'PRODUCT_PREFERENCE', 'COMMERCIAL', 'OPERATIONAL', 'SALES', 'SUPPORT', 'ONBOARDING', 'PROMISE_OR_COMMITMENT', 'RISK', 'OPPORTUNITY', 'HISTORICAL_CONTEXT', 'OTHER');

-- CreateEnum
CREATE TYPE "AccountMilestoneType" AS ENUM ('DISCOVERED', 'FIRST_OUTREACH', 'FIRST_FOLLOWUP', 'FIRST_REPLY', 'FIRST_MEETING', 'QUALIFIED', 'PROPOSAL', 'CONVERTED', 'ONBOARDING_STARTED', 'LAUNCHED', 'SUPPORT_ESCALATION', 'RENEWED', 'EXPANSION', 'CHURN_RISK', 'CANCELLED', 'REACTIVATED');

-- CreateEnum
CREATE TYPE "AccountOpenLoopStatus" AS ENUM ('OPEN', 'BLOCKED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountOpenLoopParty" AS ENUM ('CLIENT', 'TORCHIKO', 'THIRD_PARTY', 'SHARED');

-- CreateEnum
CREATE TYPE "AccountCommitmentParty" AS ENUM ('CLIENT', 'TORCHIKO', 'THIRD_PARTY', 'MUTUAL');

-- CreateEnum
CREATE TYPE "AccountCommitmentStatus" AS ENUM ('OPEN', 'FULFILLED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountSummaryStatus" AS ENUM ('CURRENT', 'STALE', 'PROCESSING', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CompanyMeetingProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETE', 'NEEDS_REVIEW', 'FAILED_RETRYABLE', 'FAILED_TERMINAL');

-- CreateEnum
CREATE TYPE "CompanyMeetingTranscriptStatus" AS ENUM ('UNAVAILABLE', 'REFERENCED', 'AVAILABLE', 'RETAINED_EXTERNALLY', 'REDACTED');

-- CreateEnum
CREATE TYPE "CompanyMeetingExtractionType" AS ENUM ('SUMMARY', 'DECISION', 'TORCHIKO_COMMITMENT', 'CLIENT_COMMITMENT', 'CLIENT_PREFERENCE', 'PRODUCT_REQUEST', 'OBJECTION', 'PRICING_DISCUSSION', 'OPPORTUNITY', 'ACTION_ITEM', 'OPEN_QUESTION', 'FACTUAL_CORRECTION');

-- CreateTable
CREATE TABLE "company_knowledge_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "venue_id" TEXT,
    "organization_id" TEXT,
    "type" "CompanyKnowledgeType" NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "summary" VARCHAR(4000) NOT NULL,
    "access_scope" "CompanyKnowledgeAccessScope" NOT NULL,
    "allowed_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authority" "CompanyKnowledgeAuthority" NOT NULL,
    "promotion_status" "CompanyKnowledgePromotionStatus" NOT NULL DEFAULT 'CANDIDATE',
    "current_revision" INTEGER NOT NULL DEFAULT 1,
    "content_hash" CHAR(64) NOT NULL,
    "confidence" DOUBLE PRECISION,
    "effective_at" TIMESTAMP(3),
    "last_confirmed_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" VARCHAR(191) NOT NULL,
    "model_provider" VARCHAR(100),
    "model_name" VARCHAR(191),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_knowledge_revisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "knowledge_item_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "structured_data" JSONB NOT NULL DEFAULT '{}',
    "source_digest" CHAR(64) NOT NULL,
    "authored_by_type" "ActorType" NOT NULL,
    "authored_by_id" VARCHAR(191) NOT NULL,
    "model_provider" VARCHAR(100),
    "model_name" VARCHAR(191),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_knowledge_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_knowledge_sources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "knowledge_item_id" TEXT NOT NULL,
    "source_type" "CompanyKnowledgeSourceType" NOT NULL,
    "source_id" VARCHAR(191),
    "source_ref" VARCHAR(1000),
    "excerpt" VARCHAR(4000),
    "occurred_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_knowledge_entity_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "knowledge_item_id" TEXT NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" VARCHAR(191) NOT NULL,
    "relationship" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_knowledge_entity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_knowledge_relations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "from_item_id" TEXT NOT NULL,
    "to_item_id" TEXT NOT NULL,
    "relation" VARCHAR(100) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_knowledge_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "knowledge_item_id" TEXT NOT NULL,
    "status" "CompanyDecisionStatus" NOT NULL DEFAULT 'PROPOSED',
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "affected_systems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effective_at" TIMESTAMP(3),
    "supersedes_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_priorities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "knowledge_item_id" TEXT NOT NULL,
    "status" "CompanyPriorityStatus" NOT NULL DEFAULT 'ACTIVE',
    "rank" INTEGER NOT NULL DEFAULT 100,
    "time_horizon" VARCHAR(191),
    "owner_id" VARCHAR(191),
    "rationale" TEXT NOT NULL,
    "workstreams" JSONB NOT NULL DEFAULT '[]',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_relationship_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "venue_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "category" "AccountRelationshipNoteCategory" NOT NULL,
    "body" VARCHAR(8000) NOT NULL,
    "authority" "CompanyKnowledgeAuthority" NOT NULL DEFAULT 'DURABLE_CONTEXT',
    "promotion_status" "CompanyKnowledgePromotionStatus" NOT NULL DEFAULT 'CANDIDATE',
    "confidence" DOUBLE PRECISION,
    "source_type" "CompanyKnowledgeSourceType" NOT NULL,
    "source_id" VARCHAR(191),
    "source_ref" VARCHAR(1000),
    "effective_at" TIMESTAMP(3),
    "last_confirmed_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "content_hash" CHAR(64) NOT NULL,
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" VARCHAR(191) NOT NULL,
    "agent_run_id" VARCHAR(191),
    "worker_id" VARCHAR(191),
    "model_provider" VARCHAR(100),
    "model_name" VARCHAR(191),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_relationship_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_milestones" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "venue_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "type" "AccountMilestoneType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "summary" VARCHAR(1000),
    "source_type" "CompanyKnowledgeSourceType" NOT NULL,
    "source_id" VARCHAR(191),
    "source_ref" VARCHAR(1000),
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_open_loops" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "venue_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "summary" VARCHAR(2000),
    "waiting_on" "AccountOpenLoopParty" NOT NULL,
    "status" "AccountOpenLoopStatus" NOT NULL DEFAULT 'OPEN',
    "due_at" TIMESTAMP(3),
    "owner_id" VARCHAR(191),
    "source_type" "CompanyKnowledgeSourceType" NOT NULL,
    "source_id" VARCHAR(191),
    "source_ref" VARCHAR(1000),
    "resolved_at" TIMESTAMP(3),
    "resolution" VARCHAR(2000),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_open_loops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_commitments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "venue_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "party" "AccountCommitmentParty" NOT NULL,
    "statement" VARCHAR(4000) NOT NULL,
    "status" "AccountCommitmentStatus" NOT NULL DEFAULT 'OPEN',
    "due_at" TIMESTAMP(3),
    "owner_id" VARCHAR(191),
    "source_type" "CompanyKnowledgeSourceType" NOT NULL,
    "source_id" VARCHAR(191),
    "source_ref" VARCHAR(1000),
    "fulfilled_at" TIMESTAMP(3),
    "outcome" VARCHAR(2000),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_summaries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AccountSummaryStatus" NOT NULL DEFAULT 'CURRENT',
    "summary" VARCHAR(4000) NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "source_inputs" JSONB NOT NULL,
    "input_digest" CHAR(64) NOT NULL,
    "confidence" DOUBLE PRECISION,
    "generated_by_type" "ActorType" NOT NULL,
    "generated_by_id" VARCHAR(191) NOT NULL,
    "model_provider" VARCHAR(100),
    "model_name" VARCHAR(191),
    "stale_at" TIMESTAMP(3),
    "failure_code" VARCHAR(100),
    "failure_message" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_meetings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "venue_id" TEXT,
    "organization_id" TEXT,
    "opportunity_id" TEXT,
    "external_provider" VARCHAR(100),
    "external_id" VARCHAR(191),
    "title" VARCHAR(500) NOT NULL,
    "meeting_type" VARCHAR(100) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "source_artifact_ref" VARCHAR(1000),
    "transcript_status" "CompanyMeetingTranscriptStatus" NOT NULL DEFAULT 'UNAVAILABLE',
    "processing_status" "CompanyMeetingProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "summary" VARCHAR(8000),
    "processing_provenance" JSONB NOT NULL DEFAULT '{}',
    "processed_at" TIMESTAMP(3),
    "failure_code" VARCHAR(100),
    "failure_message" VARCHAR(2000),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_meeting_participants" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "meeting_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "display_name" VARCHAR(191),
    "role" VARCHAR(191),
    "external_ref" VARCHAR(500),
    "is_torchiko" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_meeting_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_meeting_extractions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "meeting_id" TEXT NOT NULL,
    "knowledge_item_id" TEXT,
    "type" "CompanyMeetingExtractionType" NOT NULL,
    "content" VARCHAR(8000) NOT NULL,
    "structured_data" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION,
    "promotion_status" "CompanyKnowledgePromotionStatus" NOT NULL DEFAULT 'CANDIDATE',
    "source_start_offset" INTEGER,
    "source_end_offset" INTEGER,
    "created_by_type" "ActorType" NOT NULL,
    "created_by_id" VARCHAR(191) NOT NULL,
    "model_provider" VARCHAR(100),
    "model_name" VARCHAR(191),
    "idempotency_key" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_meeting_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_items_idempotency_key_key" ON "company_knowledge_items"("idempotency_key");

-- CreateIndex
CREATE INDEX "company_knowledge_scope_current_idx" ON "company_knowledge_items"("access_scope", "promotion_status", "authority", "updated_at");

-- CreateIndex
CREATE INDEX "company_knowledge_tenant_venue_idx" ON "company_knowledge_items"("tenant_id", "venue_id", "promotion_status", "authority", "updated_at");

-- CreateIndex
CREATE INDEX "company_knowledge_organization_idx" ON "company_knowledge_items"("organization_id", "promotion_status", "authority", "updated_at");

-- CreateIndex
CREATE INDEX "company_knowledge_type_authority_idx" ON "company_knowledge_items"("type", "promotion_status", "authority", "effective_at");

-- CreateIndex
CREATE INDEX "company_knowledge_content_hash_idx" ON "company_knowledge_items"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_items_id_tenant_id_key" ON "company_knowledge_items"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "company_knowledge_revisions_item_idx" ON "company_knowledge_revisions"("tenant_id", "knowledge_item_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_revision_key" ON "company_knowledge_revisions"("knowledge_item_id", "revision");

-- CreateIndex
CREATE INDEX "company_knowledge_sources_source_idx" ON "company_knowledge_sources"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "company_knowledge_sources_item_idx" ON "company_knowledge_sources"("knowledge_item_id", "created_at");

-- CreateIndex
CREATE INDEX "company_knowledge_entity_lookup_idx" ON "company_knowledge_entity_links"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_entity_link_key" ON "company_knowledge_entity_links"("knowledge_item_id", "entity_type", "entity_id", "relationship");

-- CreateIndex
CREATE INDEX "company_knowledge_relations_from_idx" ON "company_knowledge_relations"("tenant_id", "from_item_id");

-- CreateIndex
CREATE INDEX "company_knowledge_relations_to_idx" ON "company_knowledge_relations"("tenant_id", "to_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_knowledge_relation_key" ON "company_knowledge_relations"("from_item_id", "to_item_id", "relation");

-- CreateIndex
CREATE UNIQUE INDEX "company_decisions_knowledge_item_id_key" ON "company_decisions"("knowledge_item_id");

-- CreateIndex
CREATE INDEX "company_decisions_current_idx" ON "company_decisions"("tenant_id", "status", "effective_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_priorities_knowledge_item_id_key" ON "company_priorities"("knowledge_item_id");

-- CreateIndex
CREATE INDEX "company_priorities_current_idx" ON "company_priorities"("tenant_id", "status", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "account_relationship_notes_idempotency_key_key" ON "account_relationship_notes"("idempotency_key");

-- CreateIndex
CREATE INDEX "account_notes_current_idx" ON "account_relationship_notes"("organization_id", "promotion_status", "authority", "category", "updated_at");

-- CreateIndex
CREATE INDEX "account_notes_tenant_venue_idx" ON "account_relationship_notes"("tenant_id", "venue_id", "promotion_status", "updated_at");

-- CreateIndex
CREATE INDEX "account_notes_content_hash_idx" ON "account_relationship_notes"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "account_milestones_idempotency_key_key" ON "account_milestones"("idempotency_key");

-- CreateIndex
CREATE INDEX "account_milestones_timeline_idx" ON "account_milestones"("organization_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "account_milestones_tenant_venue_idx" ON "account_milestones"("tenant_id", "venue_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "account_open_loops_idempotency_key_key" ON "account_open_loops"("idempotency_key");

-- CreateIndex
CREATE INDEX "account_open_loops_current_idx" ON "account_open_loops"("organization_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "account_open_loops_tenant_venue_idx" ON "account_open_loops"("tenant_id", "venue_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "account_commitments_idempotency_key_key" ON "account_commitments"("idempotency_key");

-- CreateIndex
CREATE INDEX "account_commitments_current_idx" ON "account_commitments"("organization_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "account_commitments_tenant_venue_idx" ON "account_commitments"("tenant_id", "venue_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "account_summaries_current_idx" ON "account_summaries"("organization_id", "status", "version");

-- CreateIndex
CREATE INDEX "account_summaries_tenant_status_idx" ON "account_summaries"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "account_summaries_organization_version_key" ON "account_summaries"("organization_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "company_meetings_idempotency_key_key" ON "company_meetings"("idempotency_key");

-- CreateIndex
CREATE INDEX "company_meetings_organization_timeline_idx" ON "company_meetings"("organization_id", "started_at", "id");

-- CreateIndex
CREATE INDEX "company_meetings_tenant_venue_timeline_idx" ON "company_meetings"("tenant_id", "venue_id", "started_at", "id");

-- CreateIndex
CREATE INDEX "company_meetings_processing_idx" ON "company_meetings"("processing_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_meetings_provider_external_key" ON "company_meetings"("external_provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_meetings_id_tenant_id_key" ON "company_meetings"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "company_meeting_participants_meeting_idx" ON "company_meeting_participants"("meeting_id");

-- CreateIndex
CREATE INDEX "company_meeting_participants_contact_idx" ON "company_meeting_participants"("contact_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_meeting_extractions_idempotency_key_key" ON "company_meeting_extractions"("idempotency_key");

-- CreateIndex
CREATE INDEX "company_meeting_extractions_meeting_idx" ON "company_meeting_extractions"("meeting_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "company_meeting_extractions_review_idx" ON "company_meeting_extractions"("tenant_id", "promotion_status", "created_at");

-- AddForeignKey
ALTER TABLE "company_knowledge_items" ADD CONSTRAINT "company_knowledge_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_items" ADD CONSTRAINT "company_knowledge_items_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_items" ADD CONSTRAINT "company_knowledge_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_items" ADD CONSTRAINT "company_knowledge_items_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_revisions" ADD CONSTRAINT "company_knowledge_revisions_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_sources" ADD CONSTRAINT "company_knowledge_sources_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_entity_links" ADD CONSTRAINT "company_knowledge_entity_links_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_relations" ADD CONSTRAINT "company_knowledge_relations_from_item_id_fkey" FOREIGN KEY ("from_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_knowledge_relations" ADD CONSTRAINT "company_knowledge_relations_to_item_id_fkey" FOREIGN KEY ("to_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_decisions" ADD CONSTRAINT "company_decisions_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_decisions" ADD CONSTRAINT "company_decisions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "company_decisions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_priorities" ADD CONSTRAINT "company_priorities_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_relationship_notes" ADD CONSTRAINT "account_relationship_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_relationship_notes" ADD CONSTRAINT "account_relationship_notes_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_relationship_notes" ADD CONSTRAINT "account_relationship_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_relationship_notes" ADD CONSTRAINT "account_relationship_notes_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "account_relationship_notes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_milestones" ADD CONSTRAINT "account_milestones_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_milestones" ADD CONSTRAINT "account_milestones_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_milestones" ADD CONSTRAINT "account_milestones_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_open_loops" ADD CONSTRAINT "account_open_loops_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_open_loops" ADD CONSTRAINT "account_open_loops_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_open_loops" ADD CONSTRAINT "account_open_loops_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_commitments" ADD CONSTRAINT "account_commitments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_commitments" ADD CONSTRAINT "account_commitments_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_commitments" ADD CONSTRAINT "account_commitments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_summaries" ADD CONSTRAINT "account_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_summaries" ADD CONSTRAINT "account_summaries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meetings" ADD CONSTRAINT "company_meetings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meetings" ADD CONSTRAINT "company_meetings_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meetings" ADD CONSTRAINT "company_meetings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meetings" ADD CONSTRAINT "company_meetings_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "prospect_opportunities"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meeting_participants" ADD CONSTRAINT "company_meeting_participants_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "company_meetings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meeting_participants" ADD CONSTRAINT "company_meeting_participants_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meeting_extractions" ADD CONSTRAINT "company_meeting_extractions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "company_meetings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_meeting_extractions" ADD CONSTRAINT "company_meeting_extractions_knowledge_item_id_fkey" FOREIGN KEY ("knowledge_item_id") REFERENCES "company_knowledge_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
