BEGIN;

ALTER TABLE "intake_uploads" DROP CONSTRAINT "intake_uploads_status_shape_check";
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_status_shape_check" CHECK (
  ("status" = 'RESERVED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "storage_version_id" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'VERIFYING' AND "verification_claim_id" IS NOT NULL AND "verification_lease_until" IS NOT NULL AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'PRECHECK_PASSED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND char_length(btrim("storage_version_id")) BETWEEN 1 AND 1024 AND "verified_at" IS NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NULL) OR
  ("status" = 'AWAITING_REVIEW' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND char_length(btrim("storage_version_id")) BETWEEN 1 AND 1024 AND "verified_at" IS NOT NULL AND "rejected_at" IS NULL AND "rejection_code" IS NULL AND "intake_run_id" IS NOT NULL) OR
  ("status" = 'REJECTED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "rejected_at" IS NOT NULL AND "rejection_code" IN ('OBJECT_MISSING', 'GENERATION_MISMATCH', 'MIME_MISMATCH', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'UNSAFE_FILE') AND "intake_run_id" IS NULL) OR
  ("status" = 'REJECTED' AND "verification_claim_id" IS NULL AND "verification_lease_until" IS NULL AND "storage_version_id" IS NULL AND "verified_at" IS NULL AND "rejected_at" IS NOT NULL AND "rejection_code" = 'CLIENT_CANCELLED' AND "intake_run_id" IS NULL AND "multipart_upload_id" IS NOT NULL AND "multipart_started_at" IS NOT NULL AND "multipart_completed_at" IS NULL AND "multipart_aborted_at" IS NOT NULL)
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
       NEW."intake_run_id" IS NOT NULL OR
       NEW."multipart_upload_id" IS NOT NULL OR
       NEW."multipart_started_at" IS NOT NULL OR
       NEW."multipart_completed_at" IS NOT NULL OR
       NEW."multipart_aborted_at" IS NOT NULL THEN
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
  IF OLD."status" = 'RESERVED' AND NEW."status" = 'RESERVED' THEN
    IF NEW."multipart_upload_id" IS NULL OR
       NEW."multipart_started_at" IS NULL OR
       NEW."multipart_aborted_at" IS NOT NULL OR
       (OLD."multipart_upload_id" IS NOT NULL AND NEW."multipart_upload_id" IS DISTINCT FROM OLD."multipart_upload_id") OR
       (OLD."multipart_started_at" IS NOT NULL AND NEW."multipart_started_at" IS DISTINCT FROM OLD."multipart_started_at") OR
       (OLD."multipart_completed_at" IS NOT NULL AND NEW."multipart_completed_at" IS DISTINCT FROM OLD."multipart_completed_at") THEN
      RAISE EXCEPTION 'invalid intake upload transport mutation';
    END IF;
  ELSIF OLD."status" = 'RESERVED' AND NEW."status" = 'REJECTED' THEN
    IF NEW."rejection_code" IS DISTINCT FROM 'CLIENT_CANCELLED' OR
       NEW."multipart_upload_id" IS NULL OR
       NEW."multipart_started_at" IS NULL OR
       NEW."multipart_completed_at" IS NOT NULL OR
       NEW."multipart_aborted_at" IS NULL THEN
      RAISE EXCEPTION 'invalid intake upload cancellation';
    END IF;
  ELSIF OLD."status" = 'RESERVED' AND NEW."status" <> 'VERIFYING' THEN
    RAISE EXCEPTION 'invalid intake upload transition';
  END IF;
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

COMMIT;
