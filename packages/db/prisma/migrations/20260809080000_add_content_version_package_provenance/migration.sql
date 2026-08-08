BEGIN;

ALTER TABLE "places"
  ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "authorship" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "source_name" TEXT,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "imported_at" TIMESTAMP(3),
  ADD COLUMN "human_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "human_confirmed_by" TEXT,
  ADD COLUMN "last_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "last_reviewed_by" TEXT,
  ADD COLUMN "source_package_id" TEXT;

ALTER TABLE "venue_knowledge_entries"
  ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "authorship" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "source_name" TEXT,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "imported_at" TIMESTAMP(3),
  ADD COLUMN "human_confirmed_at" TIMESTAMP(3),
  ADD COLUMN "human_confirmed_by" TEXT,
  ADD COLUMN "last_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "last_reviewed_by" TEXT,
  ADD COLUMN "source_package_id" TEXT;

ALTER TABLE "places"
  ADD CONSTRAINT "places_provenance_shape_check" CHECK (
    length(btrim("source_type")) BETWEEN 1 AND 64
    AND "authorship" IN ('UNKNOWN', 'HUMAN_AUTHORED', 'AI_GENERATED')
    AND ("source_name" IS NULL OR length("source_name") <= 200)
    AND (
      "source_url" IS NULL
      OR (
        length("source_url") <= 2000
        AND "source_url" ~* '^https?://'
        AND "source_url" !~* '^https?://[^/]*@'
        AND "source_url" !~* '[?&#](sig|[^&#=]*token[^&#=]*|[^&#=]*(secret|signature|credential|password|auth)[^&#=]*|[^&#=]*key|x-amz-[^=&#]*|x-goog-[^=&#]*)='
        AND "source_url" !~ '[?#][^#]*%'
      )
    )
    AND (("human_confirmed_at" IS NULL) = ("human_confirmed_by" IS NULL))
    AND (("last_reviewed_at" IS NULL) = ("last_reviewed_by" IS NULL))
    AND (
      "source_package_id" IS NULL
      OR (
        "source_type" <> 'UNKNOWN'
        AND "authorship" <> 'UNKNOWN'
        AND "imported_at" IS NOT NULL
        AND "human_confirmed_at" IS NOT NULL
        AND "human_confirmed_by" IS NOT NULL
        AND "last_reviewed_at" IS NOT NULL
        AND "last_reviewed_by" IS NOT NULL
      )
    )
  ),
  ADD CONSTRAINT "places_source_package_scope_fkey"
  FOREIGN KEY ("source_package_id", "tenant_id", "venue_id")
  REFERENCES "venue_packages"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_knowledge_entries"
  ADD CONSTRAINT "venue_knowledge_entries_provenance_shape_check" CHECK (
    length(btrim("source_type")) BETWEEN 1 AND 64
    AND "authorship" IN ('UNKNOWN', 'HUMAN_AUTHORED', 'AI_GENERATED')
    AND ("source_name" IS NULL OR length("source_name") <= 200)
    AND (
      "source_url" IS NULL
      OR (
        length("source_url") <= 2000
        AND "source_url" ~* '^https?://'
        AND "source_url" !~* '^https?://[^/]*@'
        AND "source_url" !~* '[?&#](sig|[^&#=]*token[^&#=]*|[^&#=]*(secret|signature|credential|password|auth)[^&#=]*|[^&#=]*key|x-amz-[^=&#]*|x-goog-[^=&#]*)='
        AND "source_url" !~ '[?#][^#]*%'
      )
    )
    AND (("human_confirmed_at" IS NULL) = ("human_confirmed_by" IS NULL))
    AND (("last_reviewed_at" IS NULL) = ("last_reviewed_by" IS NULL))
    AND (
      "source_package_id" IS NULL
      OR (
        "source_type" <> 'UNKNOWN'
        AND "authorship" <> 'UNKNOWN'
        AND "imported_at" IS NOT NULL
        AND "human_confirmed_at" IS NOT NULL
        AND "human_confirmed_by" IS NOT NULL
        AND "last_reviewed_at" IS NOT NULL
        AND "last_reviewed_by" IS NOT NULL
      )
    )
  ),
  ADD CONSTRAINT "venue_knowledge_entries_source_package_scope_fkey"
  FOREIGN KEY ("source_package_id", "tenant_id", "venue_id")
  REFERENCES "venue_packages"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "places_tenant_id_source_package_id_idx"
  ON "places"("tenant_id", "source_package_id");
CREATE INDEX "venue_knowledge_entries_tenant_id_source_package_id_idx"
  ON "venue_knowledge_entries"("tenant_id", "source_package_id");

ALTER TABLE "content_versions"
  ADD COLUMN "venue_package_id" TEXT,
  ADD COLUMN "venue_package_item_key" UUID,
  ADD COLUMN "venue_package_action" TEXT,
  ADD COLUMN "source_provenance" JSONB;

ALTER TABLE "content_versions"
  ADD CONSTRAINT "content_versions_package_provenance_all_or_none_check"
  CHECK (
    (
      "venue_package_id" IS NULL
      AND "venue_package_item_key" IS NULL
      AND "venue_package_action" IS NULL
      AND "source_provenance" IS NULL
    )
    OR
    (
      "venue_package_id" IS NOT NULL
      AND "venue_package_item_key" IS NOT NULL
      AND "venue_package_action" IN ('APPLY', 'REVERT')
      AND "source_provenance" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "content_versions_source_provenance_shape_check"
  CHECK (
    "source_provenance" IS NULL
    OR (
      jsonb_typeof("source_provenance") = 'object'
      AND ("source_provenance" - ARRAY[
        'sourceType', 'sourceName', 'sourceUrl', 'contentOrigin',
        'importedAt', 'humanConfirmedAt', 'lastReviewedAt'
      ]::TEXT[]) = '{}'::JSONB
      AND jsonb_typeof("source_provenance"->'sourceType') = 'string'
      AND length(btrim("source_provenance"->>'sourceType')) BETWEEN 1 AND 64
      AND (
        NOT ("source_provenance" ? 'sourceName')
        OR (
          jsonb_typeof("source_provenance"->'sourceName') = 'string'
          AND length("source_provenance"->>'sourceName') <= 200
        )
      )
      AND (
        NOT ("source_provenance" ? 'sourceUrl')
        OR (
          jsonb_typeof("source_provenance"->'sourceUrl') = 'string'
          AND length("source_provenance"->>'sourceUrl') <= 2000
          AND ("source_provenance"->>'sourceUrl') ~* '^https?://'
          AND ("source_provenance"->>'sourceUrl') !~* '^https?://[^/]*@'
          AND ("source_provenance"->>'sourceUrl') !~* '[?&#](sig|[^&#=]*token[^&#=]*|[^&#=]*(secret|signature|credential|password|auth)[^&#=]*|[^&#=]*key|x-amz-[^=&#]*|x-goog-[^=&#]*)='
          AND ("source_provenance"->>'sourceUrl') !~ '[?#][^#]*%'
        )
      )
      AND ("source_provenance"->>'contentOrigin') IN ('HUMAN_AUTHORED', 'AI_GENERATED')
      AND jsonb_typeof("source_provenance"->'importedAt') = 'string'
      AND ("source_provenance"->>'importedAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      AND jsonb_typeof("source_provenance"->'humanConfirmedAt') = 'string'
      AND ("source_provenance"->>'humanConfirmedAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      AND jsonb_typeof("source_provenance"->'lastReviewedAt') = 'string'
      AND ("source_provenance"->>'lastReviewedAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    )
  );

ALTER TABLE "content_versions"
  ADD CONSTRAINT "content_versions_venue_package_scope_fkey"
  FOREIGN KEY ("venue_package_id", "tenant_id", "venue_id")
  REFERENCES "venue_packages"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "content_versions_package_history_idx"
  ON "content_versions"(
    "tenant_id", "venue_package_id", "venue_package_action", "sequence"
  );
CREATE UNIQUE INDEX "content_versions_package_action_item_key_key"
  ON "content_versions"(
    "venue_package_id", "venue_package_action", "venue_package_item_key"
  );
CREATE UNIQUE INDEX "content_versions_package_action_entity_key"
  ON "content_versions"(
    "venue_package_id", "venue_package_action", "entity_type", "entity_id"
  );

-- New Place and Knowledge versions use snapshot schema v2 so direct provenance
-- is exactly restorable. Existing schema-v1 rows remain unchanged and valid.
CREATE OR REPLACE FUNCTION pathfinder_capture_content_version() RETURNS trigger
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
  captured_snapshot_schema_version INTEGER;
BEGIN
  captured_entity_type := TG_ARGV[0];
  captured_operation := CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE TG_OP END;
  captured_snapshot_schema_version :=
    CASE WHEN captured_entity_type IN ('PLACE', 'KNOWLEDGE_ENTRY') THEN 2 ELSE 1 END;

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
        'isActive', OLD.is_active, 'sourceType', OLD.source_type,
        'authorship', OLD.authorship, 'sourceName', OLD.source_name,
        'sourceUrl', OLD.source_url,
        'importedAt', to_char(OLD.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedAt', to_char(OLD.human_confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedBy', OLD.human_confirmed_by,
        'lastReviewedAt', to_char(OLD.last_reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lastReviewedBy', OLD.last_reviewed_by,
        'sourcePackageId', OLD.source_package_id
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
        'isActive', NEW.is_active, 'sourceType', NEW.source_type,
        'authorship', NEW.authorship, 'sourceName', NEW.source_name,
        'sourceUrl', NEW.source_url,
        'importedAt', to_char(NEW.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedAt', to_char(NEW.human_confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedBy', NEW.human_confirmed_by,
        'lastReviewedAt', to_char(NEW.last_reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lastReviewedBy', NEW.last_reviewed_by,
        'sourcePackageId', NEW.source_package_id
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
        'isEnabled', OLD.is_enabled, 'sourceType', OLD.source_type,
        'authorship', OLD.authorship, 'sourceName', OLD.source_name,
        'sourceUrl', OLD.source_url,
        'importedAt', to_char(OLD.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedAt', to_char(OLD.human_confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedBy', OLD.human_confirmed_by,
        'lastReviewedAt', to_char(OLD.last_reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lastReviewedBy', OLD.last_reviewed_by,
        'sourcePackageId', OLD.source_package_id
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      after_snapshot := jsonb_build_object(
        'id', NEW.id, 'tenantId', NEW.tenant_id, 'venueId', NEW.venue_id,
        'title', NEW.title, 'category', NEW.category, 'content', NEW.content,
        'isEnabled', NEW.is_enabled, 'sourceType', NEW.source_type,
        'authorship', NEW.authorship, 'sourceName', NEW.source_name,
        'sourceUrl', NEW.source_url,
        'importedAt', to_char(NEW.imported_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedAt', to_char(NEW.human_confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanConfirmedBy', NEW.human_confirmed_by,
        'lastReviewedAt', to_char(NEW.last_reviewed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'lastReviewedBy', NEW.last_reviewed_by,
        'sourcePackageId', NEW.source_package_id
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
    "before_state", "after_state", "actor_id", "reverted_from_id",
    "snapshot_schema_version"
  ) VALUES (
    captured_tenant_id, captured_venue_id, captured_entity_type,
    captured_entity_id, captured_operation, before_snapshot, after_snapshot,
    captured_actor_id, captured_reverted_from_id, captured_snapshot_schema_version
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Package provenance is transaction-local input. Existing callers clear these
-- values through setContentVersionContext, so pooled connections cannot inherit
-- a prior package identity. Existing history rows remain null and are not inferred.
CREATE FUNCTION pathfinder_attach_content_version_package_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  captured_package_id TEXT;
  captured_item_key_text TEXT;
  captured_action TEXT;
  captured_provenance_text TEXT;
  captured_package_status "VenuePackageStatus";
  applied_ancestor_matches BOOLEAN;
BEGIN
  captured_package_id := NULLIF(current_setting('pathfinder.venue_package_id', true), '');
  captured_item_key_text := NULLIF(
    current_setting('pathfinder.venue_package_item_key', true), ''
  );
  captured_action := NULLIF(current_setting('pathfinder.venue_package_action', true), '');
  captured_provenance_text := NULLIF(
    current_setting('pathfinder.source_provenance', true), ''
  );

  IF NEW.entity_type NOT IN ('VENUE', 'PLACE', 'KNOWLEDGE_ENTRY') THEN
    IF captured_package_id IS NOT NULL
      OR captured_item_key_text IS NOT NULL
      OR captured_action IS NOT NULL
      OR captured_provenance_text IS NOT NULL
    THEN
      RAISE EXCEPTION 'content version package provenance cannot target this entity type';
    END IF;
    RETURN NEW;
  END IF;

  IF captured_package_id IS NULL
    AND captured_item_key_text IS NULL
    AND captured_action IS NULL
    AND captured_provenance_text IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF captured_package_id IS NULL
    OR captured_item_key_text IS NULL
    OR captured_action IS NULL
    OR captured_provenance_text IS NULL
  THEN
    RAISE EXCEPTION 'content version package provenance context is incomplete';
  END IF;

  IF captured_action NOT IN ('APPLY', 'REVERT') THEN
    RAISE EXCEPTION 'content version package action is invalid';
  END IF;

  SELECT package.status
    INTO captured_package_status
  FROM "venue_packages" AS package
  WHERE package.id = captured_package_id
    AND package.tenant_id = NEW.tenant_id
    AND package.venue_id = NEW.venue_id;

  IF captured_package_status IS NULL THEN
    RAISE EXCEPTION 'content version package scope is invalid';
  END IF;
  IF captured_action = 'APPLY' AND captured_package_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'content version package is not approved for apply provenance';
  END IF;
  IF captured_action = 'REVERT' AND captured_package_status <> 'APPLIED' THEN
    RAISE EXCEPTION 'content version package is not applied for revert provenance';
  END IF;

  NEW.venue_package_id := captured_package_id;
  NEW.venue_package_item_key := captured_item_key_text::UUID;
  NEW.venue_package_action := captured_action;
  NEW.source_provenance := captured_provenance_text::JSONB;

  IF captured_action = 'APPLY' AND NEW.reverted_from_id IS NOT NULL THEN
    RAISE EXCEPTION 'package apply provenance cannot carry revert ancestry';
  END IF;

  IF captured_action = 'REVERT' THEN
    IF NEW.reverted_from_id IS NULL THEN
      RAISE EXCEPTION 'package revert provenance requires apply ancestry';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM "content_versions" AS applied
      WHERE applied.id = NEW.reverted_from_id
        AND applied.tenant_id = NEW.tenant_id
        AND applied.venue_id = NEW.venue_id
        AND applied.entity_type = NEW.entity_type
        AND applied.entity_id = NEW.entity_id
        AND applied.venue_package_id = captured_package_id
        AND applied.venue_package_item_key = captured_item_key_text::UUID
        AND applied.venue_package_action = 'APPLY'
    ) INTO applied_ancestor_matches;
    IF NOT applied_ancestor_matches THEN
      RAISE EXCEPTION 'package revert ancestry does not match its apply version';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER content_versions_package_provenance
  BEFORE INSERT ON "content_versions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_attach_content_version_package_provenance();

COMMIT;
