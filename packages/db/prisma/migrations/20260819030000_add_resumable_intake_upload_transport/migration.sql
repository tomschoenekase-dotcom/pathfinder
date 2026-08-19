ALTER TABLE "intake_uploads"
  ADD COLUMN "multipart_upload_id" VARCHAR(1024),
  ADD COLUMN "multipart_started_at" TIMESTAMP(3),
  ADD COLUMN "multipart_completed_at" TIMESTAMP(3),
  ADD COLUMN "multipart_aborted_at" TIMESTAMP(3);

ALTER TABLE "intake_uploads"
  ADD CONSTRAINT "intake_uploads_multipart_lifecycle_check"
  CHECK (
    ("multipart_upload_id" IS NULL AND "multipart_started_at" IS NULL
      AND "multipart_completed_at" IS NULL AND "multipart_aborted_at" IS NULL)
    OR
    ("multipart_upload_id" IS NOT NULL AND "multipart_started_at" IS NOT NULL
      AND NOT ("multipart_completed_at" IS NOT NULL AND "multipart_aborted_at" IS NOT NULL))
  );
