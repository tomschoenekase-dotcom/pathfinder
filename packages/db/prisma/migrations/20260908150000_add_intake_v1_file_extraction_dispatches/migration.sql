BEGIN;
ALTER TYPE "IntakeV1ProcessingKind" ADD VALUE 'FILE_EXTRACTION';
COMMIT;

BEGIN;
ALTER TABLE "intake_v1_processing_dispatches"
  ADD COLUMN "file_extraction_receipt_id" UUID,
  ADD CONSTRAINT "intake_v1_processing_dispatches_file_receipt_scope_fkey"
    FOREIGN KEY ("file_extraction_receipt_id", "tenant_id", "venue_id", "intake_run_id")
    REFERENCES "intake_file_extraction_receipts" ("id", "tenant_id", "venue_id", "run_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "intake_v1_processing_dispatches_receipt_kind_check" CHECK (
    ("kind"::text='FILE_EXTRACTION' AND "receipt_id" IS NULL)
    OR ("kind"::text<>'FILE_EXTRACTION' AND "file_extraction_receipt_id" IS NULL)
  );
ALTER TABLE "intake_v1_processing_dispatches" DROP CONSTRAINT "intake_v1_processing_dispatches_shape_check";
ALTER TABLE "intake_v1_processing_dispatches" ADD CONSTRAINT "intake_v1_processing_dispatches_shape_check" CHECK (
    ("status" = 'PENDING' AND ("kind"::text IN ('WEBSITE_RESEARCH', 'FILE_EXTRACTION')) AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'LEASED' AND ("kind"::text IN ('WEBSITE_RESEARCH', 'FILE_EXTRACTION')) AND "lease_token" IS NOT NULL AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NOT NULL AND ((("kind"::text IN ('WEBSITE_RESEARCH', 'FILE_EXTRACTION')) AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NOT NULL) OR ("kind" = 'REVIEW_READY' AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NULL)))
    OR ("status" = 'HELD' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "hold_reason" IS NOT NULL AND "completed_at" IS NOT NULL AND ((("kind"::text IN ('WEBSITE_RESEARCH', 'FILE_EXTRACTION')) AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NOT NULL) OR ("kind" = 'EXTRACTION_UNSUPPORTED' AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NULL)))
    OR ("status" = 'HELD' AND "kind"::text='FILE_EXTRACTION' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "hold_reason" IS NOT NULL AND "completed_at" IS NOT NULL AND "receipt_id" IS NULL)
    OR ("status" = 'FAILED' AND ("kind"::text IN ('WEBSITE_RESEARCH', 'FILE_EXTRACTION')) AND "attempts" = 3 AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND COALESCE("receipt_id", "file_extraction_receipt_id") IS NULL AND "last_error" IS NOT NULL AND "completed_at" IS NOT NULL)
);

CREATE OR REPLACE FUNCTION pathfinder_validate_intake_v1_processing_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_row RECORD; receipt_row RECORD; upload_row RECORD; verified_hash TEXT;
BEGIN
  SELECT member.immutable_hash, COALESCE(member.intake_run_id, upload.intake_run_id) AS intake_run_id
    INTO member_row FROM intake_v1_submission_members member
    LEFT JOIN intake_uploads upload ON upload.id=member.intake_upload_id AND upload.tenant_id=member.tenant_id AND upload.venue_id=member.venue_id
    WHERE member.id=NEW.member_id AND member.revision_id=NEW.revision_id AND member.tenant_id=NEW.tenant_id AND member.venue_id=NEW.venue_id;
  IF NOT FOUND OR member_row.immutable_hash IS DISTINCT FROM NEW.source_hash OR member_row.intake_run_id IS DISTINCT FROM NEW.intake_run_id
  THEN RAISE EXCEPTION 'intake V1 processing source identity mismatch'; END IF;
  IF NEW.kind='WEBSITE_RESEARCH' AND NOT EXISTS (
    SELECT 1 FROM intake_runs WHERE id=NEW.intake_run_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id
      AND source_kind='WEBSITE' AND submission_input_hash=NEW.source_hash
  ) THEN RAISE EXCEPTION 'intake V1 website processing source hash mismatch'; END IF;
  IF NEW.receipt_id IS NOT NULL THEN
    SELECT run_id, outcome INTO receipt_row FROM intake_website_research_receipts
      WHERE id=NEW.receipt_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
    IF NOT FOUND OR receipt_row.run_id IS DISTINCT FROM NEW.intake_run_id
      OR (NEW.status='COMPLETED' AND receipt_row.outcome <> 'SUCCEEDED')
      OR (NEW.status='HELD' AND receipt_row.outcome = 'SUCCEEDED')
    THEN RAISE EXCEPTION 'intake V1 processing receipt identity mismatch'; END IF;
  END IF;
  IF NEW.kind::text='FILE_EXTRACTION' THEN
    SELECT upload.* INTO upload_row FROM intake_uploads upload
      JOIN intake_v1_submission_members member ON member.intake_upload_id=upload.id
        AND member.tenant_id=upload.tenant_id AND member.venue_id=upload.venue_id
      WHERE member.id=NEW.member_id AND upload.intake_run_id=NEW.intake_run_id;
    IF NOT FOUND OR NEW.policy_version <> 'intake-v1-file-extraction-v1'
      OR NOT EXISTS (SELECT 1 FROM intake_runs source WHERE source.id=NEW.intake_run_id
        AND source.tenant_id=NEW.tenant_id AND source.venue_id=NEW.venue_id AND source.source_kind='FILE_UPLOAD')
      OR upload_row.status IS DISTINCT FROM 'AWAITING_REVIEW'
      OR upload_row.mime_type NOT IN ('application/pdf','text/plain','text/markdown','text/csv','application/json')
      OR upload_row.byte_size > (CASE WHEN upload_row.mime_type='application/pdf' THEN 10485760 ELSE 2097152 END)
    THEN RAISE EXCEPTION 'intake V1 file extraction source/profile mismatch'; END IF;
    SELECT encode(sha256(convert_to(
      '{"id":' || to_json(upload_row.id)::text || ',"receipt":{"computedByteSize":' || receipt.computed_byte_size::text
      || ',"computedSha256":' || to_json(receipt.computed_sha256::text)::text
      || ',"objectGeneration":' || to_json(receipt.object_generation::text)::text
      || ',"storageVersionId":' || to_json(receipt.storage_version_id)::text
      || ',"uploadId":' || to_json(receipt.upload_id)::text
      || ',"verdictHash":' || to_json(receipt.verdict_hash::text)::text || '}}', 'UTF8')), 'hex')
    INTO verified_hash FROM intake_upload_verification_receipts receipt
      WHERE receipt.upload_id=upload_row.id AND receipt.tenant_id=NEW.tenant_id AND receipt.venue_id=NEW.venue_id
        AND receipt.kind='MALWARE' AND receipt.verdict='CLEAN'
        AND receipt.object_generation=upload_row.object_generation AND receipt.storage_version_id=upload_row.storage_version_id
        AND receipt.computed_sha256=upload_row.sha256 AND receipt.computed_byte_size=upload_row.byte_size;
    IF verified_hash IS DISTINCT FROM NEW.source_hash
    THEN RAISE EXCEPTION 'intake V1 file extraction frozen verification mismatch'; END IF;
    IF NEW.file_extraction_receipt_id IS NOT NULL THEN
      SELECT * INTO receipt_row FROM intake_file_extraction_receipts
        WHERE id=NEW.file_extraction_receipt_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id
          AND run_id=NEW.intake_run_id AND upload_id=upload_row.id;
      IF NOT FOUND OR receipt_row.source_object_generation IS DISTINCT FROM upload_row.object_generation
        OR receipt_row.source_storage_version_id IS DISTINCT FROM upload_row.storage_version_id
        OR receipt_row.source_sha256 IS DISTINCT FROM upload_row.sha256
        OR receipt_row.source_byte_size IS DISTINCT FROM upload_row.byte_size
        OR receipt_row.source_mime_type IS DISTINCT FROM upload_row.mime_type
        OR receipt_row.extractor_version <> '1'
        OR receipt_row.extractor <> (CASE WHEN upload_row.mime_type='application/pdf' THEN 'pathfinder-pdfjs-document' ELSE 'pathfinder-utf8-document' END)
        OR (NEW.status='COMPLETED' AND receipt_row.outcome <> 'SUCCEEDED')
        OR (NEW.status='HELD' AND receipt_row.outcome='SUCCEEDED')
        OR (receipt_row.outcome='SUCCEEDED' AND receipt_row.extracted_text_hash IS DISTINCT FROM encode(sha256(convert_to(receipt_row.extracted_text,'UTF8')),'hex'))
      THEN RAISE EXCEPTION 'intake V1 file extraction receipt mismatch'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
