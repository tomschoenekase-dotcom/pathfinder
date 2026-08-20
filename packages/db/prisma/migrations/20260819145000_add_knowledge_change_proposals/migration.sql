CREATE UNIQUE INDEX "venue_knowledge_entries_id_tenant_id_venue_id_key"
  ON "venue_knowledge_entries"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "conversation_insights_id_tenant_venue_key"
  ON "conversation_insights"("id", "tenant_id", "venue_id");

CREATE TYPE "KnowledgeChangeProposalStatus" AS ENUM (
  'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'PUBLISH_FAILED'
);

CREATE TABLE "knowledge_change_proposals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT,
  "conversation_insight_id" UUID,
  "target_knowledge_entry_id" TEXT,
  "published_knowledge_entry_id" TEXT,
  "observed_visitor_claim" VARCHAR(2000),
  "ai_inference" VARCHAR(2000),
  "proposed_change" VARCHAR(10000) NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL,
  "evidence_message_ids" JSONB NOT NULL DEFAULT '[]',
  "status" "KnowledgeChangeProposalStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by_type" VARCHAR(32) NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "reviewer_id" VARCHAR(191),
  "review_note" VARCHAR(2000),
  "reviewed_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "publish_error_code" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_change_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_change_proposals_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "knowledge_change_proposals_review_check" CHECK (
    ("status" IN ('DRAFT', 'PENDING_REVIEW') AND "reviewer_id" IS NULL AND "reviewed_at" IS NULL) OR
    ("status" NOT IN ('DRAFT', 'PENDING_REVIEW') AND "reviewer_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  ),
  CONSTRAINT "knowledge_change_proposals_publish_check" CHECK (
    ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "published_knowledge_entry_id" IS NOT NULL) OR
    ("status" <> 'PUBLISHED')
  )
);

CREATE UNIQUE INDEX "knowledge_change_proposals_id_tenant_id_venue_id_key"
  ON "knowledge_change_proposals"("id", "tenant_id", "venue_id");
CREATE INDEX "knowledge_change_proposals_tenant_id_venue_id_status_created_idx"
  ON "knowledge_change_proposals"("tenant_id", "venue_id", "status", "created_at");
CREATE INDEX "knowledge_change_proposals_conversation_insight_id_idx"
  ON "knowledge_change_proposals"("conversation_insight_id");
CREATE INDEX "knowledge_change_proposals_target_knowledge_entry_id_idx"
  ON "knowledge_change_proposals"("target_knowledge_entry_id");

ALTER TABLE "knowledge_change_proposals"
  ADD CONSTRAINT "knowledge_change_proposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_change_proposals_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_change_proposals_session_id_tenant_id_venue_id_fkey" FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_change_proposals_conversation_insight_id_tenant_id_venue_id_fkey" FOREIGN KEY ("conversation_insight_id", "tenant_id", "venue_id") REFERENCES "conversation_insights"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_change_proposals_target_knowledge_entry_id_tenant_id_venue_id_fkey" FOREIGN KEY ("target_knowledge_entry_id", "tenant_id", "venue_id") REFERENCES "venue_knowledge_entries"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_change_proposals_published_knowledge_entry_id_tenant_id_venue_id_fkey" FOREIGN KEY ("published_knowledge_entry_id", "tenant_id", "venue_id") REFERENCES "venue_knowledge_entries"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
