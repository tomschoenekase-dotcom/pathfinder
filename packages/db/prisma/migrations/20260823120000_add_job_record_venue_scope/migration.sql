-- Persist exact venue scope outside the opaque execution payload so operational reads remain
-- indexable and do not depend on reconstructing authorization scope from provider/job material.
ALTER TABLE "job_records" ADD COLUMN "venue_id" TEXT;

UPDATE "job_records"
   SET "venue_id" = NULLIF("payload" ->> 'venueId', '')
 WHERE "payload" ? 'venueId';

CREATE INDEX "job_records_tenant_id_venue_id_created_at_idx"
    ON "job_records"("tenant_id", "venue_id", "created_at");
