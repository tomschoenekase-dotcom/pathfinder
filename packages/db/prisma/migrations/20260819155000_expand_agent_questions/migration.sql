CREATE TYPE "AgentQuestionType" AS ENUM (
  'YES_NO', 'MULTIPLE_CHOICE', 'MULTI_SELECT', 'SHORT_TEXT', 'LONG_TEXT',
  'APPROVAL_REJECT', 'DATE_TIME', 'STRUCTURED_OBJECT'
);
CREATE TYPE "AgentQuestionUrgency" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
ALTER TYPE "AgentQuestionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "AgentQuestionStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "agent_questions"
  ADD COLUMN "question_type" "AgentQuestionType" NOT NULL DEFAULT 'SHORT_TEXT',
  ADD COLUMN "category" VARCHAR(100) NOT NULL DEFAULT 'general',
  ADD COLUMN "urgency" "AgentQuestionUrgency" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "due_at" TIMESTAMP(3),
  ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "proposed_answer" JSONB,
  ADD COLUMN "callback_metadata" JSONB;

CREATE INDEX "agent_questions_tenant_id_venue_id_urgency_due_at_idx"
  ON "agent_questions"("tenant_id", "venue_id", "urgency", "due_at");
