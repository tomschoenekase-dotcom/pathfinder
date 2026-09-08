CREATE TYPE "ConversationLearningPolicy" AS ENUM (
  'VISITOR_AND_EMPLOYEE',
  'EMPLOYEE_ONLY',
  'DISABLED'
);

ALTER TABLE "venues"
  ADD COLUMN "conversation_learning_policy" "ConversationLearningPolicy"
  NOT NULL DEFAULT 'VISITOR_AND_EMPLOYEE';

ALTER TABLE "conversation_insights"
  ADD COLUMN "candidate_provenance" JSONB,
  ADD COLUMN "candidate_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewer_feedback" VARCHAR(1000);

ALTER TABLE "conversation_insights"
  ADD CONSTRAINT "conversation_insights_candidate_revision_check"
  CHECK ("candidate_revision" >= 0);
