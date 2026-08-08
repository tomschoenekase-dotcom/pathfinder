BEGIN;

-- Preserve the prior guest-visible state while adding an explicit lifecycle,
-- then install history capture without leaving a baseline/write gap.
LOCK TABLE "operational_updates" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "content_versions" IN ACCESS EXCLUSIVE MODE;

-- The new guest retrieval contract has a hard 20-update ceiling. Refuse to
-- backfill a legacy state that would become silently truncated after deploy.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "operational_updates"
    WHERE "is_active" = true
      AND "expires_at" > CURRENT_TIMESTAMP
    GROUP BY "tenant_id", "venue_id"
    HAVING count(*) > 20
  ) THEN
    RAISE EXCEPTION
      'operational update migration blocked: a venue has more than 20 active unexpired legacy updates';
  END IF;
END;
$$;

CREATE TYPE "OperationalUpdatePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "OperationalUpdateStatus" AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE "OperationalUpdateType" AS ENUM (
  'GENERAL_NOTICE',
  'TEMPORARY_CLOSURE',
  'UNAVAILABLE_EXHIBIT',
  'CHANGED_HOURS',
  'MAINTENANCE',
  'SPECIAL_EVENT',
  'SOLD_OUT_ACTIVITY',
  'TEMPORARY_VENDOR_LOCATION'
);

ALTER TABLE "operational_updates"
  ADD COLUMN "update_type" "OperationalUpdateType" NOT NULL DEFAULT 'GENERAL_NOTICE',
  ADD COLUMN "priority" "OperationalUpdatePriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "starts_at" TIMESTAMP(3),
  ADD COLUMN "status" "OperationalUpdateStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "published_by" TEXT,
  ADD COLUMN "published_at" TIMESTAMP(3),
  ADD COLUMN "updated_at" TIMESTAMP(3);

UPDATE "operational_updates"
SET
  "starts_at" = "created_at",
  "status" = 'PUBLISHED',
  "published_by" = "created_by",
  "published_at" = "created_at",
  "updated_at" = "created_at";

ALTER TABLE "operational_updates"
  ALTER COLUMN "starts_at" SET NOT NULL,
  ALTER COLUMN "starts_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updated_at" SET NOT NULL,
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "is_active" SET DEFAULT false,
  ADD CONSTRAINT "operational_updates_time_window_check"
    CHECK ("starts_at" < "expires_at"),
  ADD CONSTRAINT "operational_updates_publication_check"
    CHECK (
      ("status" = 'DRAFT' AND "published_by" IS NULL AND "published_at" IS NULL AND "is_active" = false)
      OR
      ("status" = 'PUBLISHED' AND "published_by" IS NOT NULL AND "published_at" IS NOT NULL)
    );

DROP INDEX "operational_updates_venue_id_is_active_expires_at_idx";
DROP INDEX "operational_updates_severity_created_at_idx";
CREATE INDEX "operational_updates_tenant_id_updated_at_idx"
  ON "operational_updates"("tenant_id", "updated_at");
CREATE INDEX "operational_updates_guest_visibility_idx"
  ON "operational_updates"(
    "tenant_id", "venue_id", "status", "is_active", "starts_at", "expires_at", "priority"
  );

ALTER TABLE "content_versions"
  DROP CONSTRAINT "content_versions_entity_type_check",
  ADD CONSTRAINT "content_versions_entity_type_check"
    CHECK ("entity_type" IN ('VENUE', 'PLACE', 'KNOWLEDGE_ENTRY', 'OPERATIONAL_UPDATE'));

INSERT INTO "content_versions" (
  "tenant_id", "venue_id", "entity_type", "entity_id", "operation", "after_state"
)
SELECT
  ou."tenant_id",
  ou."venue_id",
  'OPERATIONAL_UPDATE',
  ou."id",
  'CREATE',
  jsonb_build_object(
    'id', ou."id",
    'tenantId', ou."tenant_id",
    'venueId', ou."venue_id",
    'placeId', ou."place_id",
    'updateType', ou."update_type",
    'severity', ou."severity",
    'priority', ou."priority",
    'title', ou."title",
    'body', ou."body",
    'redirectTo', ou."redirect_to",
    'startsAt', ou."starts_at",
    'expiresAt', ou."expires_at",
    'status', ou."status",
    'isActive', ou."is_active",
    'createdBy', ou."created_by",
    'publishedBy', ou."published_by",
    'publishedAt', ou."published_at",
    'createdAt', ou."created_at"
  )
FROM "operational_updates" AS ou;

CREATE FUNCTION pathfinder_capture_operational_update_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before_snapshot JSONB;
  after_snapshot JSONB;
  captured_actor_id TEXT;
  captured_reverted_from_id UUID;
  captured_operation TEXT;
BEGIN
  captured_operation := CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE TG_OP END;

  IF TG_OP <> 'INSERT' THEN
    before_snapshot := jsonb_build_object(
      'id', OLD."id",
      'tenantId', OLD."tenant_id",
      'venueId', OLD."venue_id",
      'placeId', OLD."place_id",
      'updateType', OLD."update_type",
      'severity', OLD."severity",
      'priority', OLD."priority",
      'title', OLD."title",
      'body', OLD."body",
      'redirectTo', OLD."redirect_to",
      'startsAt', OLD."starts_at",
      'expiresAt', OLD."expires_at",
      'status', OLD."status",
      'isActive', OLD."is_active",
      'createdBy', OLD."created_by",
      'publishedBy', OLD."published_by",
      'publishedAt', OLD."published_at",
      'createdAt', OLD."created_at"
    );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    after_snapshot := jsonb_build_object(
      'id', NEW."id",
      'tenantId', NEW."tenant_id",
      'venueId', NEW."venue_id",
      'placeId', NEW."place_id",
      'updateType', NEW."update_type",
      'severity', NEW."severity",
      'priority', NEW."priority",
      'title', NEW."title",
      'body', NEW."body",
      'redirectTo', NEW."redirect_to",
      'startsAt', NEW."starts_at",
      'expiresAt', NEW."expires_at",
      'status', NEW."status",
      'isActive', NEW."is_active",
      'createdBy', NEW."created_by",
      'publishedBy', NEW."published_by",
      'publishedAt', NEW."published_at",
      'createdAt', NEW."created_at"
    );
  END IF;

  IF TG_OP = 'UPDATE' AND before_snapshot = after_snapshot THEN
    RETURN NEW;
  END IF;

  captured_actor_id := NULLIF(current_setting('pathfinder.actor_id', true), '');
  captured_reverted_from_id := NULLIF(
    current_setting('pathfinder.reverted_from_id', true), ''
  )::UUID;

  INSERT INTO "content_versions" (
    "tenant_id", "venue_id", "entity_type", "entity_id", "operation",
    "before_state", "after_state", "actor_id", "reverted_from_id"
  ) VALUES (
    COALESCE(NEW."tenant_id", OLD."tenant_id"),
    COALESCE(NEW."venue_id", OLD."venue_id"),
    'OPERATIONAL_UPDATE',
    COALESCE(NEW."id", OLD."id"),
    captured_operation,
    before_snapshot,
    after_snapshot,
    captured_actor_id,
    captured_reverted_from_id
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER operational_updates_content_version
  AFTER INSERT OR UPDATE OR DELETE ON "operational_updates"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_capture_operational_update_version();

COMMIT;
