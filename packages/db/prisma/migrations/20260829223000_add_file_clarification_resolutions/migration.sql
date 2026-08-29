CREATE TYPE "IntakeFileClarificationResolutionKind" AS ENUM ('REPLACE_EXCERPT', 'EXCLUDE_EVIDENCE');

CREATE TABLE "intake_file_clarification_resolutions" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "receipt_id" UUID NOT NULL,
    "question_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "expected_extracted_text_hash" CHAR(64) NOT NULL,
    "field_path" VARCHAR(500) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "blocker_scope" VARCHAR(32) NOT NULL,
    "excerpt_hash" CHAR(64) NOT NULL,
    "answer_hash" CHAR(64) NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "kind" "IntakeFileClarificationResolutionKind" NOT NULL,
    "amended_excerpt" VARCHAR(2000),
    "amended_excerpt_hash" CHAR(64),
    "rationale" VARCHAR(500) NOT NULL,
    "created_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_file_clarification_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intake_file_resolutions_request_key" ON "intake_file_clarification_resolutions"("tenant_id", "request_id");
CREATE UNIQUE INDEX "intake_file_resolutions_question_key" ON "intake_file_clarification_resolutions"("question_id");
CREATE UNIQUE INDEX "intake_file_resolutions_question_scope_key" ON "intake_file_clarification_resolutions"("question_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "intake_file_resolutions_scope_key" ON "intake_file_clarification_resolutions"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_file_resolutions_receipt_created_idx" ON "intake_file_clarification_resolutions"("tenant_id", "venue_id", "run_id", "receipt_id", "created_at");

ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_run_id_tenant_id_venue_id_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_receipt_id_tenant_id_venue_id_run_id_fkey" FOREIGN KEY ("receipt_id", "tenant_id", "venue_id", "run_id") REFERENCES "intake_file_extraction_receipts"("id", "tenant_id", "venue_id", "run_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_question_id_tenant_id_venue_id_fkey" FOREIGN KEY ("question_id", "tenant_id", "venue_id") REFERENCES "agent_questions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_shape_check" CHECK (
    ("kind" = 'REPLACE_EXCERPT' AND "amended_excerpt" IS NOT NULL AND length(btrim("amended_excerpt")) > 0 AND "amended_excerpt_hash" IS NOT NULL)
    OR
    ("kind" = 'EXCLUDE_EVIDENCE' AND "amended_excerpt" IS NULL AND "amended_excerpt_hash" IS NULL)
);

ALTER TABLE "intake_file_clarification_resolutions" ADD CONSTRAINT "intake_file_clarification_resolutions_scope_check" CHECK ("blocker_scope" IN ('LOCAL', 'FOUNDATIONAL'));

CREATE OR REPLACE FUNCTION reject_intake_file_clarification_resolution_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER intake_file_clarification_resolutions_append_only
BEFORE UPDATE OR DELETE ON "intake_file_clarification_resolutions"
FOR EACH ROW EXECUTE FUNCTION reject_intake_file_clarification_resolution_mutation();

CREATE TRIGGER intake_file_clarification_resolutions_no_truncate
BEFORE TRUNCATE ON "intake_file_clarification_resolutions"
FOR EACH STATEMENT EXECUTE FUNCTION reject_intake_file_clarification_resolution_mutation();

ALTER TABLE "intake_file_extraction_reviews"
ADD COLUMN "clarification_resolution_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "clarification_resolution_digest" CHAR(64);

ALTER TABLE "intake_file_extraction_reviews" ADD CONSTRAINT "intake_file_extraction_reviews_clarification_resolution_shape_check" CHECK (
    ("clarification_resolution_count" = 0 AND "clarification_resolution_digest" IS NULL)
    OR
    ("clarification_resolution_count" > 0 AND "clarification_resolution_count" <= 50 AND "clarification_resolution_digest" IS NOT NULL)
);
