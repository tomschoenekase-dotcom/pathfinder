CREATE TYPE "IntakeInterviewClarificationResolutionKind" AS ENUM ('REPLACE_PUBLIC_TEXT', 'EXCLUDE_FIELD');

CREATE TABLE "intake_interview_clarification_resolutions" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "review_hash" CHAR(64) NOT NULL,
    "clarification_id" VARCHAR(191) NOT NULL,
    "field_path" VARCHAR(191) NOT NULL,
    "answer_hash" CHAR(64) NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "kind" "IntakeInterviewClarificationResolutionKind" NOT NULL,
    "amended_public_text" VARCHAR(2000),
    "amended_text_hash" CHAR(64),
    "rationale" VARCHAR(500) NOT NULL,
    "created_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_interview_clarification_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intake_interview_resolutions_request_key" ON "intake_interview_clarification_resolutions"("tenant_id", "request_id");
CREATE UNIQUE INDEX "intake_interview_resolutions_question_key" ON "intake_interview_clarification_resolutions"("question_id");
CREATE UNIQUE INDEX "intake_interview_resolutions_question_scope_key" ON "intake_interview_clarification_resolutions"("question_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "intake_interview_resolutions_scope_key" ON "intake_interview_clarification_resolutions"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_interview_resolutions_run_created_idx" ON "intake_interview_clarification_resolutions"("tenant_id", "venue_id", "run_id", "created_at");

ALTER TABLE "intake_interview_clarification_resolutions" ADD CONSTRAINT "intake_interview_clarification_resolutions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_interview_clarification_resolutions" ADD CONSTRAINT "intake_interview_clarification_resolutions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_interview_clarification_resolutions" ADD CONSTRAINT "intake_interview_clarification_resolutions_run_id_tenant_id_venue_id_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_interview_clarification_resolutions" ADD CONSTRAINT "intake_interview_clarification_resolutions_question_id_tenant_id_venue_id_fkey" FOREIGN KEY ("question_id", "tenant_id", "venue_id") REFERENCES "agent_questions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "intake_interview_clarification_resolutions" ADD CONSTRAINT "intake_interview_clarification_resolutions_shape_check" CHECK (
    ("kind" = 'REPLACE_PUBLIC_TEXT' AND "amended_public_text" IS NOT NULL AND length(btrim("amended_public_text")) > 0 AND "amended_text_hash" IS NOT NULL)
    OR
    ("kind" = 'EXCLUDE_FIELD' AND "amended_public_text" IS NULL AND "amended_text_hash" IS NULL)
);

CREATE OR REPLACE FUNCTION reject_intake_interview_clarification_resolution_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER intake_interview_clarification_resolutions_append_only
BEFORE UPDATE OR DELETE ON "intake_interview_clarification_resolutions"
FOR EACH ROW EXECUTE FUNCTION reject_intake_interview_clarification_resolution_mutation();

CREATE TRIGGER intake_interview_clarification_resolutions_no_truncate
BEFORE TRUNCATE ON "intake_interview_clarification_resolutions"
FOR EACH STATEMENT EXECUTE FUNCTION reject_intake_interview_clarification_resolution_mutation();
