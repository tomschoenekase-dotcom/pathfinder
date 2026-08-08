BEGIN;

ALTER TABLE "media_ingestion_projects"
ADD COLUMN "source_fingerprint_algorithm" VARCHAR(48),
ADD COLUMN "source_fingerprint" CHAR(64);

ALTER TABLE "media_ingestion_projects"
ADD CONSTRAINT "media_ingestion_projects_source_fingerprint_check"
CHECK (
  (
    "source_fingerprint_algorithm" IS NULL
    AND "source_fingerprint" IS NULL
  )
  OR (
    "source_fingerprint_algorithm" IS NOT NULL
    AND "source_fingerprint" IS NOT NULL
    AND "source_fingerprint_algorithm" = 'pathfinder-sha256-part-manifest-v1'
    AND "source_fingerprint" ~ '^[0-9a-f]{64}$'
  )
);

COMMIT;
