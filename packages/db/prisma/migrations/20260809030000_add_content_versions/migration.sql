BEGIN;

-- Keep the baseline scan and trigger installation gap-free. Ordinary INSERT,
-- UPDATE, and DELETE statements take ROW EXCLUSIVE locks and wait until this
-- migration commits with all three capture triggers installed.
LOCK TABLE "venues", "places", "venue_knowledge_entries" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "content_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sequence" BIGINT GENERATED ALWAYS AS IDENTITY,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "actor_id" TEXT,
    "reverted_from_id" UUID,
    "snapshot_schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "content_versions_sequence_key" UNIQUE ("sequence"),
    CONSTRAINT "content_versions_entity_type_check"
      CHECK ("entity_type" IN ('VENUE', 'PLACE', 'KNOWLEDGE_ENTRY')),
    CONSTRAINT "content_versions_operation_check"
      CHECK ("operation" IN ('CREATE', 'UPDATE', 'DELETE')),
    CONSTRAINT "content_versions_snapshot_schema_version_check"
      CHECK ("snapshot_schema_version" > 0),
    CONSTRAINT "content_versions_state_check"
      CHECK (
        ("operation" = 'CREATE' AND "before_state" IS NULL AND "after_state" IS NOT NULL)
        OR ("operation" = 'UPDATE' AND "before_state" IS NOT NULL AND "after_state" IS NOT NULL)
        OR ("operation" = 'DELETE' AND "before_state" IS NOT NULL AND "after_state" IS NULL)
      )
);

ALTER TABLE "content_versions"
  ADD CONSTRAINT "content_versions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "content_versions_tenant_id_entity_type_entity_id_sequence_idx"
  ON "content_versions"("tenant_id", "entity_type", "entity_id", "sequence");
CREATE INDEX "content_versions_tenant_id_entity_type_sequence_idx"
  ON "content_versions"("tenant_id", "entity_type", "sequence");
CREATE INDEX "content_versions_tenant_id_venue_id_sequence_idx"
  ON "content_versions"("tenant_id", "venue_id", "sequence");
CREATE INDEX "content_versions_reverted_from_id_idx"
  ON "content_versions"("reverted_from_id");

-- Establish a real, restorable baseline before enabling change capture. Without
-- these rows, the first post-deploy edit or deletion of existing content would
-- have no selectable pre-change version in the portal.
INSERT INTO "content_versions" (
  "tenant_id", "venue_id", "entity_type", "entity_id", "operation", "after_state"
)
SELECT
  venue.tenant_id, venue.id, 'VENUE', venue.id, 'CREATE',
  jsonb_build_object(
    'id', venue.id, 'tenantId', venue.tenant_id, 'venueId', venue.id,
    'name', venue.name, 'slug', venue.slug, 'description', venue.description,
    'guideNotes', venue.guide_notes, 'aiGuideNotes', venue.ai_guide_notes,
    'aiFeaturedPlaceId', venue.ai_featured_place_id, 'aiTone', venue.ai_tone,
    'aiGuideName', venue.ai_guide_name, 'chatTheme', venue.chat_theme,
    'chatAccentColor', venue.chat_accent_color, 'chatFont', venue.chat_font,
    'chatLogoUrl', venue.chat_logo_url, 'chatBannerUrl', venue.chat_banner_url,
    'category', venue.category, 'guideMode', venue.guide_mode,
    'defaultCenterLat', venue.default_center_lat,
    'defaultCenterLng', venue.default_center_lng,
    'geoBoundary', venue.geo_boundary, 'isActive', venue.is_active
  )
FROM venues AS venue;

INSERT INTO "content_versions" (
  "tenant_id", "venue_id", "entity_type", "entity_id", "operation", "after_state"
)
SELECT
  place.tenant_id, place.venue_id, 'PLACE', place.id, 'CREATE',
  jsonb_build_object(
    'id', place.id, 'tenantId', place.tenant_id, 'venueId', place.venue_id,
    'name', place.name, 'type', place.type, 'itemType', place.item_type,
    'shortDescription', place.short_description,
    'longDescription', place.long_description, 'lat', place.lat, 'lng', place.lng,
    'tags', place.tags, 'importanceScore', place.importance_score,
    'areaName', place.area_name, 'hours', place.hours, 'photoUrl', place.photo_url,
    'isActive', place.is_active
  )
FROM places AS place;

INSERT INTO "content_versions" (
  "tenant_id", "venue_id", "entity_type", "entity_id", "operation", "after_state"
)
SELECT
  entry.tenant_id, entry.venue_id, 'KNOWLEDGE_ENTRY', entry.id, 'CREATE',
  jsonb_build_object(
    'id', entry.id, 'tenantId', entry.tenant_id, 'venueId', entry.venue_id,
    'title', entry.title, 'category', entry.category, 'content', entry.content,
    'isEnabled', entry.is_enabled
  )
FROM venue_knowledge_entries AS entry;

CREATE FUNCTION pathfinder_content_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'content_versions is append-only';
END;
$$;

CREATE TRIGGER content_versions_append_only
  BEFORE UPDATE OR DELETE ON "content_versions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_content_version_guard();

CREATE TRIGGER content_versions_no_truncate
  BEFORE TRUNCATE ON "content_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_content_version_guard();

CREATE FUNCTION pathfinder_capture_content_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before_snapshot JSONB;
  after_snapshot JSONB;
  captured_tenant_id TEXT;
  captured_venue_id TEXT;
  captured_entity_id TEXT;
  captured_entity_type TEXT;
  captured_actor_id TEXT;
  captured_reverted_from_id UUID;
  captured_operation TEXT;
BEGIN
  captured_entity_type := TG_ARGV[0];
  captured_operation := CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE TG_OP END;

  IF captured_entity_type = 'VENUE' THEN
    IF TG_OP <> 'INSERT' THEN
      before_snapshot := jsonb_build_object(
        'id', OLD.id, 'tenantId', OLD.tenant_id, 'venueId', OLD.id,
        'name', OLD.name, 'slug', OLD.slug, 'description', OLD.description,
        'guideNotes', OLD.guide_notes, 'aiGuideNotes', OLD.ai_guide_notes,
        'aiFeaturedPlaceId', OLD.ai_featured_place_id, 'aiTone', OLD.ai_tone,
        'aiGuideName', OLD.ai_guide_name, 'chatTheme', OLD.chat_theme,
        'chatAccentColor', OLD.chat_accent_color, 'chatFont', OLD.chat_font,
        'chatLogoUrl', OLD.chat_logo_url, 'chatBannerUrl', OLD.chat_banner_url,
        'category', OLD.category, 'guideMode', OLD.guide_mode,
        'defaultCenterLat', OLD.default_center_lat,
        'defaultCenterLng', OLD.default_center_lng,
        'geoBoundary', OLD.geo_boundary, 'isActive', OLD.is_active
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      after_snapshot := jsonb_build_object(
        'id', NEW.id, 'tenantId', NEW.tenant_id, 'venueId', NEW.id,
        'name', NEW.name, 'slug', NEW.slug, 'description', NEW.description,
        'guideNotes', NEW.guide_notes, 'aiGuideNotes', NEW.ai_guide_notes,
        'aiFeaturedPlaceId', NEW.ai_featured_place_id, 'aiTone', NEW.ai_tone,
        'aiGuideName', NEW.ai_guide_name, 'chatTheme', NEW.chat_theme,
        'chatAccentColor', NEW.chat_accent_color, 'chatFont', NEW.chat_font,
        'chatLogoUrl', NEW.chat_logo_url, 'chatBannerUrl', NEW.chat_banner_url,
        'category', NEW.category, 'guideMode', NEW.guide_mode,
        'defaultCenterLat', NEW.default_center_lat,
        'defaultCenterLng', NEW.default_center_lng,
        'geoBoundary', NEW.geo_boundary, 'isActive', NEW.is_active
      );
    END IF;
    captured_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
    captured_venue_id := COALESCE(NEW.id, OLD.id);
    captured_entity_id := captured_venue_id;
  ELSIF captured_entity_type = 'PLACE' THEN
    IF TG_OP <> 'INSERT' THEN
      before_snapshot := jsonb_build_object(
        'id', OLD.id, 'tenantId', OLD.tenant_id, 'venueId', OLD.venue_id,
        'name', OLD.name, 'type', OLD.type, 'itemType', OLD.item_type,
        'shortDescription', OLD.short_description,
        'longDescription', OLD.long_description, 'lat', OLD.lat, 'lng', OLD.lng,
        'tags', OLD.tags, 'importanceScore', OLD.importance_score,
        'areaName', OLD.area_name, 'hours', OLD.hours, 'photoUrl', OLD.photo_url,
        'isActive', OLD.is_active
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      after_snapshot := jsonb_build_object(
        'id', NEW.id, 'tenantId', NEW.tenant_id, 'venueId', NEW.venue_id,
        'name', NEW.name, 'type', NEW.type, 'itemType', NEW.item_type,
        'shortDescription', NEW.short_description,
        'longDescription', NEW.long_description, 'lat', NEW.lat, 'lng', NEW.lng,
        'tags', NEW.tags, 'importanceScore', NEW.importance_score,
        'areaName', NEW.area_name, 'hours', NEW.hours, 'photoUrl', NEW.photo_url,
        'isActive', NEW.is_active
      );
    END IF;
    captured_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
    captured_venue_id := COALESCE(NEW.venue_id, OLD.venue_id);
    captured_entity_id := COALESCE(NEW.id, OLD.id);
  ELSE
    IF TG_OP <> 'INSERT' THEN
      before_snapshot := jsonb_build_object(
        'id', OLD.id, 'tenantId', OLD.tenant_id, 'venueId', OLD.venue_id,
        'title', OLD.title, 'category', OLD.category, 'content', OLD.content,
        'isEnabled', OLD.is_enabled
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      after_snapshot := jsonb_build_object(
        'id', NEW.id, 'tenantId', NEW.tenant_id, 'venueId', NEW.venue_id,
        'title', NEW.title, 'category', NEW.category, 'content', NEW.content,
        'isEnabled', NEW.is_enabled
      );
    END IF;
    captured_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
    captured_venue_id := COALESCE(NEW.venue_id, OLD.venue_id);
    captured_entity_id := COALESCE(NEW.id, OLD.id);
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
    captured_tenant_id, captured_venue_id, captured_entity_type,
    captured_entity_id, captured_operation, before_snapshot, after_snapshot,
    captured_actor_id, captured_reverted_from_id
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER venues_content_version
  AFTER INSERT OR UPDATE OR DELETE ON "venues"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_capture_content_version('VENUE');
CREATE TRIGGER places_content_version
  AFTER INSERT OR UPDATE OR DELETE ON "places"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_capture_content_version('PLACE');
CREATE TRIGGER venue_knowledge_entries_content_version
  AFTER INSERT OR UPDATE OR DELETE ON "venue_knowledge_entries"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_capture_content_version('KNOWLEDGE_ENTRY');

COMMIT;
