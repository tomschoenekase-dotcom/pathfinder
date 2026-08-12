ALTER TYPE "IntakeSourceKind" ADD VALUE 'FILE_UPLOAD';

BEGIN;

CREATE TYPE "IntakeUploadStatus" AS ENUM ('RESERVED', 'VERIFYING', 'AWAITING_REVIEW', 'REJECTED');

CREATE TABLE "intake_uploads" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "display_name" VARCHAR(255) NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(64) NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "object_key" VARCHAR(255) NOT NULL,
  "object_generation" UUID NOT NULL,
  "storage_version_id" VARCHAR(1024),
  "status" "IntakeUploadStatus" NOT NULL DEFAULT 'RESERVED',
  "verification_claim_id" UUID,
  "verification_claimed_at" TIMESTAMP(3),
  "verification_lease_until" TIMESTAMP(3),
  "verified_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "rejection_code" VARCHAR(64),
  "intake_run_id" TEXT,
  "requested_by" VARCHAR(191) NOT NULL,
  "requested_by_role" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intake_uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intake_uploads_object_key_key" ON "intake_uploads"("object_key");
CREATE UNIQUE INDEX "intake_uploads_tenant_request_key" ON "intake_uploads"("tenant_id", "request_id");
CREATE UNIQUE INDEX "intake_uploads_run_scope_key" ON "intake_uploads"("intake_run_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "intake_uploads_scope_key" ON "intake_uploads"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_uploads_scope_created_idx" ON "intake_uploads"("tenant_id", "venue_id", "created_at");

ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_run_scope_fkey"
  FOREIGN KEY ("intake_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_metadata_check" CHECK (
  "mime_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/tiff') AND
  "byte_size" BETWEEN 1 AND 26214400 AND
  "sha256" ~ '^[a-f0-9]{64}$' AND
  "request_hash" ~ '^[a-f0-9]{64}$' AND
  char_length(btrim("display_name")) BETWEEN 1 AND 255 AND
  char_length(btrim("file_name")) BETWEEN 1 AND 255 AND
  "requested_by_role" IN ('STAFF', 'MANAGER', 'OWNER', 'PLATFORM_ADMIN')
);
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_claim_pair_check" CHECK (
  ("verification_claim_id" IS NULL) = ("verification_claimed_at" IS NULL) AND
  ("verification_claim_id" IS NULL) = ("verification_lease_until" IS NULL) AND
  ("verification_lease_until" IS NULL OR "verification_lease_until" > "verification_claimed_at")
);
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_status_shape_check" CHECK (
  ("status" = 'RESERVED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "storage_version_id" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'VERIFYING' AND "verification_claim_id" IS NOT NULL AND "verification_lease_until" IS NOT NULL AND "storage_version_id" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'AWAITING_REVIEW' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND char_length(btrim("storage_version_id")) BETWEEN 1 AND 1024 AND "verified_at" IS NOT NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NOT NULL) OR
  ("status" = 'REJECTED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "storage_version_id" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NOT NULL AND "rejection_code" IN ('OBJECT_MISSING', 'GENERATION_MISMATCH', 'MIME_MISMATCH', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'UNSAFE_FILE') AND "intake_run_id" IS NULL)
);

CREATE FUNCTION "guard_intake_upload_lifecycle"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'intake upload evidence cannot be deleted'; END IF;
  IF ROW(NEW."tenant_id", NEW."venue_id", NEW."request_id", NEW."request_hash", NEW."display_name", NEW."file_name", NEW."mime_type", NEW."byte_size", NEW."sha256", NEW."object_key", NEW."object_generation", NEW."requested_by", NEW."requested_by_role", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."tenant_id", OLD."venue_id", OLD."request_id", OLD."request_hash", OLD."display_name", OLD."file_name", OLD."mime_type", OLD."byte_size", OLD."sha256", OLD."object_key", OLD."object_generation", OLD."requested_by", OLD."requested_by_role", OLD."created_at") THEN
    RAISE EXCEPTION 'intake upload identity is immutable';
  END IF;
  IF OLD."status" IN ('AWAITING_REVIEW', 'REJECTED') THEN
    RAISE EXCEPTION 'terminal intake upload is immutable';
  END IF;
  IF OLD."status" = 'RESERVED' AND NEW."status" <> 'VERIFYING' THEN
    RAISE EXCEPTION 'invalid intake upload transition';
  END IF;
  IF OLD."status" = 'VERIFYING' AND NEW."status" = 'VERIFYING' AND NOT (
    (OLD."verification_claim_id" = NEW."verification_claim_id") OR
    (OLD."verification_lease_until" <= CURRENT_TIMESTAMP AND NEW."verification_claim_id" <> OLD."verification_claim_id")
  ) THEN RAISE EXCEPTION 'invalid intake upload claim mutation'; END IF;
  IF OLD."status" = 'VERIFYING' AND NEW."status" NOT IN ('VERIFYING', 'AWAITING_REVIEW', 'REJECTED') THEN
    RAISE EXCEPTION 'invalid intake upload transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "intake_uploads_lifecycle_guard"
  BEFORE UPDATE OR DELETE ON "intake_uploads"
  FOR EACH ROW EXECUTE FUNCTION "guard_intake_upload_lifecycle"();

CREATE FUNCTION "block_intake_upload_truncate"() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'intake upload evidence cannot be truncated'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "intake_uploads_truncate_guard"
  BEFORE TRUNCATE ON "intake_uploads"
  FOR EACH STATEMENT EXECUTE FUNCTION "block_intake_upload_truncate"();

ALTER TABLE "intake_runs" DROP CONSTRAINT "intake_runs_source_shape_check";
ALTER TABLE "intake_runs" ADD CONSTRAINT "intake_runs_source_shape_check" CHECK (
  ("source_kind" = 'WEBSITE' AND "website_uri" IS NOT NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL AND "structured_bootstrap" IS NULL AND "submission_request_id" IS NULL AND "submission_input_hash" IS NULL) OR
  ("source_kind" = 'INTERVIEW' AND "website_uri" IS NULL AND "interview_role" IN ('EXECUTIVE', 'VISITOR_SERVICES', 'OPERATIONS', 'ACCESSIBILITY', 'CONTENT') AND "interview_public_answers" IS NOT NULL AND "interview_answer_manifest" IS NOT NULL AND "interview_consent_text_hash" ~ '^[a-f0-9]{64}$' AND "structured_bootstrap" IS NULL AND "submission_request_id" IS NULL AND "submission_input_hash" IS NULL) OR
  ("source_kind" = 'STRUCTURED_BOOTSTRAP' AND "website_uri" IS NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL AND jsonb_typeof("structured_bootstrap") = 'object' AND "submission_request_id" IS NOT NULL AND "submission_input_hash" ~ '^[a-f0-9]{64}$') OR
  ("source_kind" = 'FILE_UPLOAD' AND "website_uri" IS NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL AND "structured_bootstrap" IS NULL AND "submission_request_id" IS NULL AND "submission_input_hash" IS NULL)
);

COMMIT;
