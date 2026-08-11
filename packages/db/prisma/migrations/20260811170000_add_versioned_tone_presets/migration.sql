-- Additive only: legacy ai_tone remains in place for compatibility.
BEGIN;

ALTER TABLE "venues"
  ADD COLUMN "tone_preset" TEXT,
  ADD COLUMN "tone_preset_version" INTEGER;

-- Backfill only legacy values with an unambiguous safe mapping. Unknown custom
-- values remain null and continue through the application compatibility path.
UPDATE "venues"
SET
  "tone_preset" = CASE "ai_tone"
    WHEN 'FRIENDLY' THEN 'friendly'
    WHEN 'PROFESSIONAL' THEN 'informative'
    WHEN 'PLAYFUL' THEN 'enthusiastic'
  END,
  "tone_preset_version" = CASE
    WHEN "ai_tone" IN ('FRIENDLY', 'PROFESSIONAL', 'PLAYFUL') THEN 1
  END
WHERE "tone_preset" IS NULL;

ALTER TABLE "venues"
  ALTER COLUMN "tone_preset" SET DEFAULT 'friendly',
  ALTER COLUMN "tone_preset_version" SET DEFAULT 1,
  ADD CONSTRAINT "venues_tone_preset_check"
    CHECK ("tone_preset" IS NULL OR "tone_preset" IN (
      'friendly', 'concise', 'enthusiastic', 'informative'
    )),
  ADD CONSTRAINT "venues_tone_preset_version_check"
    CHECK (
      ("tone_preset" IS NULL AND "tone_preset_version" IS NULL)
      OR ("tone_preset" IS NOT NULL AND "tone_preset_version" > 0)
    );

-- Venue snapshots move to schema v2. Place and knowledge history retain the
-- existing capture function and schema so this migration stays narrowly scoped.
CREATE FUNCTION pathfinder_capture_venue_content_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before_snapshot JSONB;
  after_snapshot JSONB;
  captured_tenant_id TEXT;
  captured_venue_id TEXT;
  captured_actor_id TEXT;
  captured_reverted_from_id UUID;
  captured_operation TEXT;
BEGIN
  captured_operation := CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE TG_OP END;

  IF TG_OP <> 'INSERT' THEN
    before_snapshot := jsonb_build_object(
      'id', OLD.id, 'tenantId', OLD.tenant_id, 'venueId', OLD.id,
      'name', OLD.name, 'slug', OLD.slug, 'description', OLD.description,
      'guideNotes', OLD.guide_notes, 'aiGuideNotes', OLD.ai_guide_notes,
      'aiFeaturedPlaceId', OLD.ai_featured_place_id, 'aiTone', OLD.ai_tone,
      'tonePreset', OLD.tone_preset,
      'tonePresetVersion', OLD.tone_preset_version,
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
      'tonePreset', NEW.tone_preset,
      'tonePresetVersion', NEW.tone_preset_version,
      'aiGuideName', NEW.ai_guide_name, 'chatTheme', NEW.chat_theme,
      'chatAccentColor', NEW.chat_accent_color, 'chatFont', NEW.chat_font,
      'chatLogoUrl', NEW.chat_logo_url, 'chatBannerUrl', NEW.chat_banner_url,
      'category', NEW.category, 'guideMode', NEW.guide_mode,
      'defaultCenterLat', NEW.default_center_lat,
      'defaultCenterLng', NEW.default_center_lng,
      'geoBoundary', NEW.geo_boundary, 'isActive', NEW.is_active
    );
  END IF;

  IF TG_OP = 'UPDATE' AND before_snapshot = after_snapshot THEN
    RETURN NEW;
  END IF;

  captured_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  captured_venue_id := COALESCE(NEW.id, OLD.id);
  captured_actor_id := NULLIF(current_setting('pathfinder.actor_id', true), '');
  captured_reverted_from_id := NULLIF(
    current_setting('pathfinder.reverted_from_id', true), ''
  )::UUID;

  INSERT INTO "content_versions" (
    "tenant_id", "venue_id", "entity_type", "entity_id", "operation",
    "before_state", "after_state", "actor_id", "reverted_from_id",
    "snapshot_schema_version"
  ) VALUES (
    captured_tenant_id, captured_venue_id, 'VENUE', captured_venue_id,
    captured_operation, before_snapshot, after_snapshot, captured_actor_id,
    captured_reverted_from_id, 2
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER "venues_content_version" ON "venues";
CREATE TRIGGER "venues_content_version"
  AFTER INSERT OR UPDATE OR DELETE ON "venues"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_capture_venue_content_version();

COMMIT;
