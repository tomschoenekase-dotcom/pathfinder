CREATE TYPE "IntakeV1SubmissionStatus" AS ENUM ('AWAITING_CANONICAL_REVIEW');
CREATE TYPE "IntakeV1SubmissionMemberKind" AS ENUM ('INTAKE_RUN', 'INTAKE_UPLOAD');

CREATE TABLE "intake_v1_submissions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "status" "IntakeV1SubmissionStatus" NOT NULL DEFAULT 'AWAITING_CANONICAL_REVIEW',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intake_v1_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_v1_submissions_tenant_operation_key" UNIQUE ("tenant_id", "operation_id"),
  CONSTRAINT "intake_v1_submissions_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_v1_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_v1_submissions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_v1_submissions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "intake_v1_submissions_owner_resume_idx" ON "intake_v1_submissions"("tenant_id", "venue_id", "owner_user_id", "updated_at");

CREATE TABLE "intake_v1_submission_revisions" (
  "id" TEXT NOT NULL,
  "submission_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "operation_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "manifest" JSONB NOT NULL CHECK (jsonb_typeof("manifest") = 'object' AND octet_length("manifest"::text) <= 65536),
  "manifest_hash" CHAR(64) NOT NULL CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  "critical_missing" JSONB NOT NULL CHECK (jsonb_typeof("critical_missing") = 'array' AND octet_length("critical_missing"::text) <= 16384),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_v1_submission_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_v1_submission_revisions_number_key" UNIQUE ("submission_id", "revision"),
  CONSTRAINT "intake_v1_submission_revisions_tenant_operation_key" UNIQUE ("tenant_id", "operation_id"),
  CONSTRAINT "intake_v1_submission_revisions_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_v1_submission_revisions_submission_id_tenant_id_venue_id_fkey" FOREIGN KEY ("submission_id", "tenant_id", "venue_id") REFERENCES "intake_v1_submissions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "intake_v1_submission_revisions_scope_created_idx" ON "intake_v1_submission_revisions"("tenant_id", "venue_id", "created_at");

CREATE TABLE "intake_v1_submission_members" (
  "id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0 AND "ordinal" < 50),
  "kind" "IntakeV1SubmissionMemberKind" NOT NULL,
  "intake_run_id" TEXT,
  "intake_upload_id" TEXT,
  "immutable_hash" CHAR(64) NOT NULL CHECK ("immutable_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "intake_v1_submission_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_v1_submission_members_ordinal_key" UNIQUE ("revision_id", "ordinal"),
  CONSTRAINT "intake_v1_submission_members_revision_run_key" UNIQUE ("revision_id", "intake_run_id"),
  CONSTRAINT "intake_v1_submission_members_revision_upload_key" UNIQUE ("revision_id", "intake_upload_id"),
  CONSTRAINT "intake_v1_submission_members_revision_id_tenant_id_venue_id_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id") REFERENCES "intake_v1_submission_revisions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_v1_submission_members_intake_run_id_tenant_id_venue_id_fkey" FOREIGN KEY ("intake_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_v1_submission_members_intake_upload_id_tenant_id_venue_id_fkey" FOREIGN KEY ("intake_upload_id", "tenant_id", "venue_id") REFERENCES "intake_uploads"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_v1_submission_members_exactly_one_member_check" CHECK (("kind" = 'INTAKE_RUN' AND "intake_run_id" IS NOT NULL AND "intake_upload_id" IS NULL) OR ("kind" = 'INTAKE_UPLOAD' AND "intake_upload_id" IS NOT NULL AND "intake_run_id" IS NULL))
);
CREATE INDEX "intake_v1_submission_members_run_idx" ON "intake_v1_submission_members"("tenant_id", "venue_id", "intake_run_id");
CREATE INDEX "intake_v1_submission_members_upload_idx" ON "intake_v1_submission_members"("tenant_id", "venue_id", "intake_upload_id");

CREATE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE FUNCTION pathfinder_guard_intake_v1_submission_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.venue_id <> OLD.venue_id OR NEW.owner_user_id <> OLD.owner_user_id OR NEW.operation_id <> OLD.operation_id OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'intake_v1_submissions immutable identity fields cannot change'; END IF;
  IF NEW.revision < OLD.revision THEN RAISE EXCEPTION 'intake_v1_submissions revision cannot decrease'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intake_v1_submissions_identity_guard BEFORE UPDATE ON "intake_v1_submissions" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_intake_v1_submission_update();
CREATE TRIGGER intake_v1_submissions_no_delete BEFORE DELETE ON "intake_v1_submissions" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
CREATE TRIGGER intake_v1_submissions_no_truncate BEFORE TRUNCATE ON "intake_v1_submissions" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
CREATE TRIGGER intake_v1_submission_revisions_append_only BEFORE UPDATE OR DELETE ON "intake_v1_submission_revisions" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
CREATE TRIGGER intake_v1_submission_revisions_no_truncate BEFORE TRUNCATE ON "intake_v1_submission_revisions" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
CREATE TRIGGER intake_v1_submission_members_append_only BEFORE UPDATE OR DELETE ON "intake_v1_submission_members" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
CREATE TRIGGER intake_v1_submission_members_no_truncate BEFORE TRUNCATE ON "intake_v1_submission_members" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
