CREATE TYPE "ConversationInsightCategory" AS ENUM (
  'VISITOR_INTENT', 'NAVIGATION_REQUEST', 'UNANSWERED_QUESTION',
  'LOW_CONFIDENCE_ANSWER', 'KNOWLEDGE_GAP', 'CONFUSION_POINT', 'COMPLAINT',
  'COMPLIMENT', 'ACCESSIBILITY_CONCERN', 'AMENITY_REQUEST', 'EXHIBIT_INTEREST',
  'PURCHASE_INTENT', 'STAFF_ASSISTANCE_NEEDED', 'CONTENT_UPDATE_CANDIDATE',
  'SENTIMENT_SIGNAL'
);

CREATE TYPE "ConversationInsightSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "ConversationInsightReviewStatus" AS ENUM ('UNREVIEWED', 'ACKNOWLEDGED', 'ACTIONED', 'DISMISSED');

CREATE TABLE "conversation_insights" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "guest_chat_turn_id" UUID,
  "category" "ConversationInsightCategory" NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL,
  "severity" "ConversationInsightSeverity" NOT NULL DEFAULT 'INFO',
  "summary" VARCHAR(1000) NOT NULL,
  "suggested_action" VARCHAR(1000),
  "evidence_message_ids" JSONB NOT NULL DEFAULT '[]',
  "message_sequence_start" INTEGER,
  "message_sequence_end" INTEGER,
  "capability" VARCHAR(64) NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "model" VARCHAR(191) NOT NULL,
  "analyzer_version" VARCHAR(64) NOT NULL,
  "review_status" "ConversationInsightReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
  "reviewed_by" VARCHAR(191),
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_insights_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_insights_message_range_check" CHECK (
    "message_sequence_start" IS NULL OR "message_sequence_end" IS NULL OR
    "message_sequence_start" <= "message_sequence_end"
  ),
  CONSTRAINT "conversation_insights_review_check" CHECK (
    ("review_status" = 'UNREVIEWED' AND "reviewed_by" IS NULL AND "reviewed_at" IS NULL) OR
    ("review_status" <> 'UNREVIEWED' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "conversation_insights_turn_category_version_key"
  ON "conversation_insights"("tenant_id", "venue_id", "guest_chat_turn_id", "category", "analyzer_version");
CREATE INDEX "conversation_insights_tenant_id_venue_id_category_created_at_idx"
  ON "conversation_insights"("tenant_id", "venue_id", "category", "created_at");
CREATE INDEX "conversation_insights_review_queue_idx"
  ON "conversation_insights"("tenant_id", "venue_id", "review_status", "severity", "created_at");
CREATE INDEX "conversation_insights_session_id_created_at_idx"
  ON "conversation_insights"("session_id", "created_at");

ALTER TABLE "conversation_insights"
  ADD CONSTRAINT "conversation_insights_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "conversation_insights_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "conversation_insights_session_id_tenant_id_venue_id_fkey" FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "conversation_insights_guest_chat_turn_id_tenant_id_venue_id_session_id_fkey" FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id") REFERENCES "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
