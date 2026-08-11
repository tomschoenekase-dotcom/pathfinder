BEGIN;

CREATE TYPE "IntakeSourceKind" AS ENUM ('WEBSITE', 'INTERVIEW');
CREATE TYPE "IntakeRunStatus" AS ENUM ('AWAITING_REVIEW');
CREATE TYPE "IntakeEventKind" AS ENUM ('PROPOSAL_CREATED', 'EVIDENCE_RECORDED', 'PACKAGE_DRAFT_LINKED');

CREATE TABLE "intake_runs" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "source_kind" "IntakeSourceKind" NOT NULL, "status" "IntakeRunStatus" NOT NULL DEFAULT 'AWAITING_REVIEW',
  "display_name" VARCHAR(255) NOT NULL, "website_uri" VARCHAR(2000),
  "interview_role" VARCHAR(32), "interview_public_answers" JSONB,
  "interview_answer_manifest" JSONB, "interview_consent_text_hash" CHAR(64),
  "requested_by" VARCHAR(191) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_runs_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_runs_scope_kind_key" UNIQUE ("id", "tenant_id", "venue_id", "source_kind"),
  CONSTRAINT "intake_runs_source_shape_check" CHECK (
    ("source_kind" = 'WEBSITE' AND "website_uri" IS NOT NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL) OR
    ("source_kind" = 'INTERVIEW' AND "website_uri" IS NULL AND "interview_role" IN ('EXECUTIVE', 'VISITOR_SERVICES', 'OPERATIONS', 'ACCESSIBILITY', 'CONTENT') AND "interview_public_answers" IS NOT NULL AND "interview_answer_manifest" IS NOT NULL AND "interview_consent_text_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "intake_runs_interview_public_answers_array_check" CHECK ("interview_public_answers" IS NULL OR jsonb_typeof("interview_public_answers") = 'array'),
  CONSTRAINT "intake_runs_interview_manifest_array_check" CHECK ("interview_answer_manifest" IS NULL OR jsonb_typeof("interview_answer_manifest") = 'array')
);
CREATE TABLE "intake_evidence" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL, "run_id" TEXT NOT NULL,
  "source_kind" "IntakeSourceKind" NOT NULL, "locator" VARCHAR(2000) NOT NULL,
  "normalized_hash" CHAR(64) NOT NULL, "confidence" DECIMAL(4,3) NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_evidence_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_evidence_hash_check" CHECK ("normalized_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "intake_evidence_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1)
);
CREATE TABLE "intake_run_events" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL, "run_id" TEXT NOT NULL,
  "kind" "IntakeEventKind" NOT NULL, "actor_id" VARCHAR(191) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_run_events_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "intake_package_handoffs" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL, "run_id" TEXT NOT NULL,
  "package_draft_id" TEXT NOT NULL, "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_package_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_package_handoffs_run_scope_key" UNIQUE ("run_id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_package_handoffs_package_scope_key" UNIQUE ("package_draft_id", "tenant_id", "venue_id")
);

ALTER TABLE "intake_runs" ADD CONSTRAINT "intake_runs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_runs" ADD CONSTRAINT "intake_runs_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_evidence" ADD CONSTRAINT "intake_evidence_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_evidence" ADD CONSTRAINT "intake_evidence_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_evidence" ADD CONSTRAINT "intake_evidence_run_scope_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id", "source_kind") REFERENCES "intake_runs"("id", "tenant_id", "venue_id", "source_kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_run_events" ADD CONSTRAINT "intake_run_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_run_events" ADD CONSTRAINT "intake_run_events_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_run_events" ADD CONSTRAINT "intake_run_events_run_scope_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_package_handoffs" ADD CONSTRAINT "intake_package_handoffs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_package_handoffs" ADD CONSTRAINT "intake_package_handoffs_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_package_handoffs" ADD CONSTRAINT "intake_package_handoffs_run_scope_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_package_handoffs" ADD CONSTRAINT "intake_package_handoffs_package_scope_fkey" FOREIGN KEY ("package_draft_id", "tenant_id", "venue_id") REFERENCES "venue_packages"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "intake_runs_scope_created_idx" ON "intake_runs"("tenant_id", "venue_id", "created_at");
CREATE INDEX "intake_evidence_scope_run_idx" ON "intake_evidence"("tenant_id", "venue_id", "run_id", "captured_at");
CREATE INDEX "intake_run_events_scope_run_idx" ON "intake_run_events"("tenant_id", "venue_id", "run_id", "created_at");
CREATE INDEX "intake_package_handoffs_scope_created_idx" ON "intake_package_handoffs"("tenant_id", "venue_id", "created_at");

CREATE FUNCTION pathfinder_reject_intake_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER intake_runs_append_only BEFORE UPDATE OR DELETE ON "intake_runs" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_runs_no_truncate BEFORE TRUNCATE ON "intake_runs" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_evidence_append_only BEFORE UPDATE OR DELETE ON "intake_evidence" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_evidence_no_truncate BEFORE TRUNCATE ON "intake_evidence" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_run_events_append_only BEFORE UPDATE OR DELETE ON "intake_run_events" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_run_events_no_truncate BEFORE TRUNCATE ON "intake_run_events" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_package_handoffs_append_only BEFORE UPDATE OR DELETE ON "intake_package_handoffs" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_mutation();
CREATE TRIGGER intake_package_handoffs_no_truncate BEFORE TRUNCATE ON "intake_package_handoffs" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_mutation();

COMMIT;
