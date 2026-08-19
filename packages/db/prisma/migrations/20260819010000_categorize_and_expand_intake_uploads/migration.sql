BEGIN;

CREATE TYPE "IntakeUploadCategory" AS ENUM (
  'WEBSITE',
  'DOCUMENT',
  'PHOTO',
  'VIDEO_AUDIO',
  'FLOOR_PLAN',
  'FAQ',
  'STAFF_INTERVIEW',
  'OTHER'
);

ALTER TABLE "intake_uploads"
  ADD COLUMN "category" "IntakeUploadCategory" NOT NULL DEFAULT 'OTHER';

ALTER TABLE "intake_uploads" DROP CONSTRAINT "intake_uploads_metadata_check";
ALTER TABLE "intake_uploads" ADD CONSTRAINT "intake_uploads_metadata_check" CHECK (
  "mime_type" IN (
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/tiff',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/webm'
  ) AND
  "byte_size" BETWEEN 1 AND 2000000000 AND
  "sha256" ~ '^[a-f0-9]{64}$' AND
  "request_hash" ~ '^[a-f0-9]{64}$' AND
  char_length(btrim("display_name")) BETWEEN 1 AND 255 AND
  char_length(btrim("file_name")) BETWEEN 1 AND 255 AND
  "requested_by_role" IN ('STAFF', 'MANAGER', 'OWNER', 'PLATFORM_ADMIN')
);

CREATE FUNCTION "guard_intake_upload_category_immutable"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."category" IS DISTINCT FROM OLD."category" THEN
    RAISE EXCEPTION 'intake upload category is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "intake_upload_category_immutable_guard"
  BEFORE UPDATE ON "intake_uploads"
  FOR EACH ROW EXECUTE FUNCTION "guard_intake_upload_category_immutable"();

CREATE INDEX "intake_uploads_scope_category_created_idx"
  ON "intake_uploads"("tenant_id", "venue_id", "category", "created_at");

COMMIT;
