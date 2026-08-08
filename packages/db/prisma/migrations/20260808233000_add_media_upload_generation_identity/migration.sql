-- Persist the active multipart-upload generation so API routes can bind part
-- signing, completion, and explicit aborts to the attempt created for a media
-- project. Existing upload ingress and active media workers must be stopped
-- and drained before this migration, and old application instances must remain
-- stopped until the generation-aware version is live. Legacy QUEUED/FAILED
-- jobs remain bounded by the replacement worker's null-generation compatibility
-- path; actively uploading or processing rows are not safe to cross the deploy.
DO $$
BEGIN
  LOCK TABLE "media_ingestion_projects" IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM "media_ingestion_projects"
    WHERE "status" IN ('UPLOADING', 'INVENTORYING', 'ANALYZING', 'SYNTHESIZING')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Media upload ingress and workers must be stopped and active media processing drained before adding generation identity';
  END IF;

  EXECUTE $ddl$
    ALTER TABLE "media_ingestion_projects"
      ADD COLUMN "upload_attempt_id" UUID,
      ADD COLUMN "storage_upload_id" TEXT,
      ADD COLUMN "upload_started_at" TIMESTAMP(3),
      ADD COLUMN "source_content_type" TEXT
  $ddl$;

  EXECUTE $ddl$
    CREATE INDEX "media_ingestion_projects_status_stage_upload_started_at_idx"
    ON "media_ingestion_projects"("status", "stage", "upload_started_at")
  $ddl$;
END
$$;
