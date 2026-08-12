-- Forward-only verification evidence. Existing uploads are intentionally not
-- inferred or backfilled; legacy AWAITING_REVIEW rows retain unknown scan truth.
ALTER TYPE "IntakeUploadStatus" ADD VALUE 'PRECHECK_PASSED' BEFORE 'AWAITING_REVIEW';

BEGIN;

CREATE TYPE "IntakeUploadVerificationKind" AS ENUM ('PRECHECK', 'RESOURCE_SAFETY', 'MALWARE');
CREATE TYPE "IntakeUploadVerificationVerdict" AS ENUM ('PASSED', 'CLEAN', 'REJECTED');

CREATE TABLE "intake_upload_verification_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "upload_id" TEXT NOT NULL,
  "kind" "IntakeUploadVerificationKind" NOT NULL,
  "verdict" "IntakeUploadVerificationVerdict" NOT NULL,
  "engine" VARCHAR(64) NOT NULL,
  "engine_version" VARCHAR(64) NOT NULL,
  "verdict_hash" CHAR(64) NOT NULL,
  "object_generation" UUID NOT NULL,
  "storage_version_id" VARCHAR(1024) NOT NULL,
  "computed_byte_size" INTEGER NOT NULL,
  "computed_sha256" CHAR(64) NOT NULL,
  "claim_id" UUID NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_upload_verification_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_upload_verification_receipt_shape_check" CHECK (
    char_length(btrim("engine")) BETWEEN 1 AND 64 AND
    char_length(btrim("engine_version")) BETWEEN 1 AND 64 AND
    "verdict_hash" ~ '^[a-f0-9]{64}$' AND
    char_length(btrim("storage_version_id")) BETWEEN 1 AND 1024 AND
    "computed_byte_size" BETWEEN 1 AND 2147483647 AND
    "computed_sha256" ~ '^[a-f0-9]{64}$' AND
    (("kind" IN ('PRECHECK', 'RESOURCE_SAFETY') AND "verdict" IN ('PASSED', 'REJECTED')) OR
     ("kind" = 'MALWARE' AND "verdict" IN ('CLEAN', 'REJECTED')))
  )
);

CREATE UNIQUE INDEX "intake_upload_verification_kind_key"
  ON "intake_upload_verification_receipts"("upload_id", "kind");
CREATE UNIQUE INDEX "intake_upload_verification_claim_kind_key"
  ON "intake_upload_verification_receipts"("claim_id", "kind");
CREATE INDEX "intake_upload_verification_scope_idx"
  ON "intake_upload_verification_receipts"("tenant_id", "venue_id", "recorded_at");
ALTER TABLE "intake_upload_verification_receipts"
  ADD CONSTRAINT "intake_upload_verification_upload_scope_fkey"
  FOREIGN KEY ("upload_id", "tenant_id", "venue_id")
  REFERENCES "intake_uploads"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_intake_upload_verification_receipt"() RETURNS TRIGGER AS $$
DECLARE upload_record RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'intake upload verification receipt is immutable';
  END IF;
  SELECT "object_generation", "storage_version_id", "byte_size", "sha256", "status", "verification_claim_id", "verification_lease_until"
    INTO upload_record
    FROM "intake_uploads"
   WHERE "id" = NEW."upload_id" AND "tenant_id" = NEW."tenant_id" AND "venue_id" = NEW."venue_id"
   FOR KEY SHARE;
  IF NOT FOUND OR upload_record."status" <> 'VERIFYING' OR
     upload_record."verification_claim_id" IS DISTINCT FROM NEW."claim_id" OR
     upload_record."verification_lease_until" IS NULL OR
     upload_record."verification_lease_until" <= CURRENT_TIMESTAMP OR
     NEW."object_generation" IS DISTINCT FROM upload_record."object_generation" OR
     NEW."storage_version_id" IS DISTINCT FROM upload_record."storage_version_id" OR
     (NEW."verdict" IN ('PASSED', 'CLEAN') AND (
       NEW."computed_byte_size" IS DISTINCT FROM upload_record."byte_size" OR
       NEW."computed_sha256" IS DISTINCT FROM upload_record."sha256"
     )) THEN
    RAISE EXCEPTION 'intake upload verification receipt object evidence mismatch';
  END IF;
  IF NEW."kind" IN ('RESOURCE_SAFETY', 'MALWARE') AND NOT EXISTS (
    SELECT 1 FROM "intake_upload_verification_receipts" prior
     WHERE prior."upload_id" = NEW."upload_id" AND prior."kind" = 'PRECHECK' AND prior."verdict" = 'PASSED'
  ) THEN
    RAISE EXCEPTION 'authoritative verification requires passed local precheck evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "intake_upload_verification_receipt_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "intake_upload_verification_receipts"
  FOR EACH ROW EXECUTE FUNCTION "guard_intake_upload_verification_receipt"();

CREATE FUNCTION "block_intake_upload_verification_receipt_truncate"() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'intake upload verification receipt cannot be truncated'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "intake_upload_verification_receipt_truncate_guard"
  BEFORE TRUNCATE ON "intake_upload_verification_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION "block_intake_upload_verification_receipt_truncate"();

-- Replace the lifecycle shape/guard without reconstructing historical scan truth.
ALTER TABLE "intake_uploads" DROP CONSTRAINT "intake_uploads_status_shape_check";
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_status_shape_check" CHECK (
  ("status" = 'RESERVED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "storage_version_id" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'VERIFYING' AND "verification_claim_id" IS NOT NULL AND "verification_lease_until" IS NOT NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'PRECHECK_PASSED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND char_length(btrim("storage_version_id")) BETWEEN 1 AND 1024 AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'AWAITING_REVIEW' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND char_length(btrim("storage_version_id")) BETWEEN 1 AND 1024 AND "verified_at" IS NOT NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NOT NULL) OR
  ("status" = 'REJECTED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "rejected_at" IS NOT NULL AND "rejection_code" IN ('OBJECT_MISSING', 'GENERATION_MISMATCH', 'MIME_MISMATCH', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'UNSAFE_FILE') AND "intake_run_id" IS NULL)
);

CREATE OR REPLACE FUNCTION "guard_intake_upload_lifecycle"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' OR
       NEW."verification_claim_id" IS NOT NULL OR
       NEW."verification_claimed_at" IS NOT NULL OR
       NEW."verification_lease_until" IS NOT NULL OR
       NEW."storage_version_id" IS NOT NULL OR
       NEW."verified_at" IS NOT NULL OR
       NEW."rejected_at" IS NOT NULL OR
       NEW."rejection_code" IS NOT NULL OR
       NEW."intake_run_id" IS NOT NULL THEN
      RAISE EXCEPTION 'new intake upload must be pristine reserved evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'intake upload evidence cannot be deleted'; END IF;
  IF ROW(NEW."tenant_id", NEW."venue_id", NEW."request_id", NEW."request_hash", NEW."display_name", NEW."file_name", NEW."mime_type", NEW."byte_size", NEW."sha256", NEW."object_key", NEW."object_generation", NEW."requested_by", NEW."requested_by_role", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."tenant_id", OLD."venue_id", OLD."request_id", OLD."request_hash", OLD."display_name", OLD."file_name", OLD."mime_type", OLD."byte_size", OLD."sha256", OLD."object_key", OLD."object_generation", OLD."requested_by", OLD."requested_by_role", OLD."created_at") THEN
    RAISE EXCEPTION 'intake upload identity is immutable';
  END IF;
  IF OLD."status" IN ('AWAITING_REVIEW', 'REJECTED') THEN RAISE EXCEPTION 'terminal intake upload is immutable'; END IF;
  IF OLD."status" = 'RESERVED' AND NEW."status" <> 'VERIFYING' THEN RAISE EXCEPTION 'invalid intake upload transition'; END IF;
  IF OLD."status" = 'PRECHECK_PASSED' AND NEW."status" <> 'VERIFYING' THEN RAISE EXCEPTION 'invalid intake upload transition'; END IF;
  IF OLD."status" = 'VERIFYING' AND NEW."status" = 'VERIFYING' AND NOT (
    OLD."verification_claim_id" = NEW."verification_claim_id" OR
    (OLD."verification_lease_until" <= CURRENT_TIMESTAMP AND NEW."verification_claim_id" <> OLD."verification_claim_id")
  ) THEN RAISE EXCEPTION 'invalid intake upload claim mutation'; END IF;
  IF OLD."status" = 'VERIFYING' AND NEW."status" NOT IN ('VERIFYING', 'PRECHECK_PASSED', 'AWAITING_REVIEW', 'REJECTED') THEN RAISE EXCEPTION 'invalid intake upload transition'; END IF;
  IF NEW."status" = 'PRECHECK_PASSED' AND OLD."status" IS DISTINCT FROM 'PRECHECK_PASSED' AND NOT EXISTS (
    SELECT 1 FROM "intake_upload_verification_receipts" receipt
     WHERE receipt."upload_id" = NEW."id" AND receipt."kind" = 'PRECHECK' AND receipt."verdict" = 'PASSED'
  ) THEN RAISE EXCEPTION 'precheck transition requires exact passed receipt'; END IF;
  IF NEW."status" = 'AWAITING_REVIEW' AND OLD."status" IS DISTINCT FROM 'AWAITING_REVIEW' AND NOT (
    EXISTS (SELECT 1 FROM "intake_upload_verification_receipts" receipt WHERE receipt."upload_id" = NEW."id" AND receipt."kind" = 'PRECHECK' AND receipt."verdict" = 'PASSED') AND
    EXISTS (SELECT 1 FROM "intake_upload_verification_receipts" receipt WHERE receipt."upload_id" = NEW."id" AND receipt."kind" = 'RESOURCE_SAFETY' AND receipt."verdict" = 'PASSED') AND
    EXISTS (SELECT 1 FROM "intake_upload_verification_receipts" receipt WHERE receipt."upload_id" = NEW."id" AND receipt."kind" = 'MALWARE' AND receipt."verdict" = 'CLEAN')
  ) THEN RAISE EXCEPTION 'review transition requires exact authoritative receipts'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "intake_uploads_lifecycle_guard" ON "intake_uploads";
CREATE TRIGGER "intake_uploads_lifecycle_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "intake_uploads"
  FOR EACH ROW EXECUTE FUNCTION "guard_intake_upload_lifecycle"();

COMMIT;
