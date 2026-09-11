ALTER TABLE "content_module_revisions"
  ADD CONSTRAINT "content_module_revisions_id_scope_key" UNIQUE ("id", "tenant_id", "venue_id");

ALTER TABLE "content_module_publications"
  ADD CONSTRAINT "content_module_publications_id_scope_key" UNIQUE ("id", "tenant_id", "venue_id");

ALTER TABLE "content_module_publications"
  ADD CONSTRAINT "content_module_publications_projection_scope_key"
  UNIQUE ("id", "tenant_id", "venue_id", "revision_id", "module_id");

ALTER TABLE "venue_knowledge_entries"
  ADD COLUMN "content_module_id" TEXT,
  ADD COLUMN "content_revision_id" TEXT,
  ADD COLUMN "content_publication_id" TEXT;

ALTER TABLE "venue_knowledge_entries"
  ADD CONSTRAINT "venue_knowledge_entries_projection_links_all_or_none_check"
    CHECK (
      ("content_module_id" IS NULL AND "content_revision_id" IS NULL AND "content_publication_id" IS NULL)
      OR
      ("content_module_id" IS NOT NULL AND "content_revision_id" IS NOT NULL AND "content_publication_id" IS NOT NULL)
    ),
  ADD CONSTRAINT "venue_knowledge_entries_content_module_scope_fkey"
    FOREIGN KEY ("content_module_id", "tenant_id", "venue_id")
    REFERENCES "content_module_identities" ("id", "tenant_id", "venue_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_knowledge_entries_content_revision_scope_fkey"
    FOREIGN KEY ("content_revision_id", "tenant_id", "venue_id")
    REFERENCES "content_module_revisions" ("id", "tenant_id", "venue_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venue_knowledge_entries_content_publication_scope_fkey"
    FOREIGN KEY ("content_publication_id", "tenant_id", "venue_id", "content_revision_id", "content_module_id")
    REFERENCES "content_module_publications" ("id", "tenant_id", "venue_id", "revision_id", "module_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "venue_knowledge_entries_content_module_scope_key"
  ON "venue_knowledge_entries" ("tenant_id", "venue_id", "content_module_id");
CREATE INDEX "venue_knowledge_entries_content_revision_scope_idx"
  ON "venue_knowledge_entries" ("tenant_id", "venue_id", "content_revision_id");
CREATE INDEX "venue_knowledge_entries_content_publication_scope_idx"
  ON "venue_knowledge_entries" ("tenant_id", "venue_id", "content_publication_id");

CREATE FUNCTION sync_universal_content_search_projection(p_publication_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  projected RECORD;
  projection_id TEXT;
  current_publication_id TEXT;
BEGIN
  SELECT publication."id" AS publication_id,
         publication."tenant_id",
         publication."venue_id",
         publication."module_id",
         publication."revision_id",
         publication."module_kind",
         publication."action",
         revision."version",
         revision."audience",
         CASE publication."module_kind"
           WHEN 'POLICY' THEN policy."title"
           WHEN 'OPERATIONAL_FACT' THEN operational_fact."label"
           WHEN 'EVENT' THEN event."name"
           WHEN 'SERVICE' THEN service."name"
           WHEN 'ITEM' THEN item."name"
           WHEN 'RELATIONSHIP' THEN NULL
         END AS title,
         publication."module_kind"::TEXT AS category,
         CASE publication."module_kind"
           WHEN 'POLICY' THEN policy."rule"
           WHEN 'OPERATIONAL_FACT' THEN operational_fact."value"
           WHEN 'EVENT' THEN concat_ws(E'\n', event."description", 'Starts: ' || event."starts_at"::TEXT, 'Ends: ' || coalesce(event."ends_at"::TEXT, 'not specified'))
           WHEN 'SERVICE' THEN concat_ws(E'\n', service."description", service."availability")
           WHEN 'ITEM' THEN concat_ws(E'\n', item."description", 'Item type: ' || item."item_type")
           WHEN 'RELATIONSHIP' THEN NULL
         END AS content
    INTO projected
    FROM "content_module_publications" publication
    JOIN "content_module_revisions" revision
      ON revision."id" = publication."revision_id"
     AND revision."tenant_id" = publication."tenant_id"
     AND revision."venue_id" = publication."venue_id"
     AND revision."module_id" = publication."module_id"
     AND revision."kind" = publication."module_kind"
    LEFT JOIN "policy_content" policy ON policy."revision_id" = revision."id"
    LEFT JOIN "operational_fact_content" operational_fact ON operational_fact."revision_id" = revision."id"
    LEFT JOIN "event_content" event ON event."revision_id" = revision."id"
    LEFT JOIN "service_content" service ON service."revision_id" = revision."id"
    LEFT JOIN "item_content" item ON item."revision_id" = revision."id"
    LEFT JOIN "relationship_content" relationship ON relationship."revision_id" = revision."id"
   WHERE publication."id" = p_publication_id
     AND NOT EXISTS (
       SELECT 1
         FROM "content_module_publications" newer
        WHERE newer."tenant_id" = publication."tenant_id"
          AND newer."venue_id" = publication."venue_id"
          AND newer."module_id" = publication."module_id"
          AND newer."event_order" > publication."event_order"
     );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Universal content publication % is missing or inconsistent', p_publication_id;
  END IF;

  projection_id := 'ucm_' || md5(projected."tenant_id" || ':' || projected."venue_id" || ':' || projected."module_id");

  SELECT entry."content_publication_id"
    INTO current_publication_id
    FROM "venue_knowledge_entries" entry
   WHERE entry."tenant_id" = projected."tenant_id"
     AND entry."venue_id" = projected."venue_id"
     AND entry."content_module_id" = projected."module_id";

  -- Repair/backfill is idempotent. Replaying the exact current event must not
  -- invalidate a completed embedding or move its optimistic-lock timestamp.
  IF current_publication_id = projected.publication_id THEN
    RETURN;
  END IF;

  IF projected."action" = 'WITHDRAW' OR projected."audience" <> 'PUBLIC' OR projected."module_kind" = 'RELATIONSHIP' THEN
    UPDATE "venue_knowledge_entries"
       SET "is_enabled" = FALSE,
           "content_revision_id" = projected."revision_id",
           "content_publication_id" = projected.publication_id,
           "embedding" = NULL,
           "updated_at" = clock_timestamp()
     WHERE "tenant_id" = projected."tenant_id"
       AND "venue_id" = projected."venue_id"
       AND "content_module_id" = projected."module_id";
    RETURN;
  END IF;

  IF projected.title IS NULL OR projected.content IS NULL THEN
    RAISE EXCEPTION 'Searchable universal content publication % has no typed payload', p_publication_id;
  END IF;

  INSERT INTO "venue_knowledge_entries" (
    "id", "tenant_id", "venue_id", "title", "category", "content",
    "is_enabled", "visibility", "source_type", "authorship", "source_name",
    "content_module_id", "content_revision_id", "content_publication_id",
    "created_at", "updated_at"
  ) VALUES (
    projection_id, projected."tenant_id", projected."venue_id", projected.title,
    projected.category, projected.content, TRUE, 'PUBLIC', 'UNIVERSAL_CONTENT',
    'UNKNOWN', projected."module_kind"::TEXT || ' v' || projected."version"::TEXT,
    projected."module_id", projected."revision_id", projected.publication_id,
    clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT ("tenant_id", "venue_id", "content_module_id") DO UPDATE SET
    "title" = EXCLUDED."title",
    "category" = EXCLUDED."category",
    "content" = EXCLUDED."content",
    "is_enabled" = TRUE,
    "visibility" = 'PUBLIC',
    "source_type" = 'UNIVERSAL_CONTENT',
    "authorship" = 'UNKNOWN',
    "source_name" = EXCLUDED."source_name",
    "content_revision_id" = EXCLUDED."content_revision_id",
    "content_publication_id" = EXCLUDED."content_publication_id",
    "embedding" = NULL,
    "updated_at" = clock_timestamp();

  -- The generic embedding trigger only updates an existing dispatch when the
  -- text is unchanged. A new revision still invalidates vector provenance, so
  -- explicitly create the missing dispatch as well as resetting an existing one.
  INSERT INTO "embedding_dispatches" (
    "id", "tenant_id", "venue_id", "entity_type", "entity_id", "content_updated_at",
    "attempts", "next_attempt_at", "lease_token", "lease_expires_at", "last_error",
    "created_at", "updated_at"
  )
  SELECT
    'knowledge:' || entry."id", entry."tenant_id", entry."venue_id",
    'KNOWLEDGE_ENTRY'::"EmbeddingWorkEntityType", entry."id", entry."updated_at",
    0, clock_timestamp(), NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
    FROM "venue_knowledge_entries" entry
   WHERE entry."tenant_id" = projected."tenant_id"
     AND entry."venue_id" = projected."venue_id"
     AND entry."content_module_id" = projected."module_id"
  ON CONFLICT ("tenant_id", "venue_id", "entity_type", "entity_id") DO UPDATE SET
    "content_updated_at" = EXCLUDED."content_updated_at",
    "attempts" = 0,
    "next_attempt_at" = clock_timestamp(),
    "lease_token" = NULL,
    "lease_expires_at" = NULL,
    "last_error" = NULL,
    "updated_at" = clock_timestamp();
END;
$$;

CREATE FUNCTION guard_universal_content_search_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."content_module_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Universal content search projections are publication-ledger derived and cannot be deleted directly';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."content_module_id" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() <= 1 OR NOT EXISTS (
      SELECT 1
        FROM "content_module_publications" publication
        JOIN "content_module_revisions" revision
          ON revision."id" = publication."revision_id"
         AND revision."tenant_id" = publication."tenant_id"
         AND revision."venue_id" = publication."venue_id"
         AND revision."module_id" = publication."module_id"
        LEFT JOIN "policy_content" policy ON policy."revision_id" = revision."id"
        LEFT JOIN "operational_fact_content" fact ON fact."revision_id" = revision."id"
        LEFT JOIN "event_content" event ON event."revision_id" = revision."id"
        LEFT JOIN "service_content" service ON service."revision_id" = revision."id"
        LEFT JOIN "item_content" item ON item."revision_id" = revision."id"
       WHERE publication."id" = NEW."content_publication_id"
         AND publication."tenant_id" = NEW."tenant_id"
         AND publication."venue_id" = NEW."venue_id"
         AND publication."module_id" = NEW."content_module_id"
         AND publication."revision_id" = NEW."content_revision_id"
         AND publication."action" = 'PUBLISH'
         AND revision."audience" = 'PUBLIC'
         AND revision."kind" <> 'RELATIONSHIP'
         AND NOT EXISTS (
           SELECT 1 FROM "content_module_publications" newer
            WHERE newer."tenant_id" = publication."tenant_id"
              AND newer."venue_id" = publication."venue_id"
              AND newer."module_id" = publication."module_id"
              AND newer."event_order" > publication."event_order"
         )
         AND NEW."title" = CASE revision."kind"
           WHEN 'POLICY' THEN policy."title" WHEN 'OPERATIONAL_FACT' THEN fact."label"
           WHEN 'EVENT' THEN event."name" WHEN 'SERVICE' THEN service."name"
           WHEN 'ITEM' THEN item."name" END
         AND NEW."content" = CASE revision."kind"
           WHEN 'POLICY' THEN policy."rule"
           WHEN 'OPERATIONAL_FACT' THEN fact."value"
           WHEN 'EVENT' THEN concat_ws(E'\n', event."description", 'Starts: ' || event."starts_at"::TEXT, 'Ends: ' || coalesce(event."ends_at"::TEXT, 'not specified'))
           WHEN 'SERVICE' THEN concat_ws(E'\n', service."description", service."availability")
           WHEN 'ITEM' THEN concat_ws(E'\n', item."description", 'Item type: ' || item."item_type") END
         AND NEW."category" = revision."kind"::TEXT
         AND NEW."is_enabled" = TRUE
         AND NEW."visibility" = 'PUBLIC'
         AND NEW."source_type" = 'UNIVERSAL_CONTENT'
         AND NEW."authorship" = 'UNKNOWN'
         AND NEW."embedding" IS NULL
    ) THEN
      RAISE EXCEPTION 'Linked universal content search projections can only be inserted from the current publication ledger event';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."content_module_id" IS NULL AND NEW."content_module_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Publication-triggered synchronization is the only path allowed to change
  -- canonical projection fields. Embedding workers may still update embedding
  -- and its normal updated_at timestamp through their fenced write.
  IF OLD."content_module_id" IS NULL OR NEW."content_module_id" IS NULL THEN
    RAISE EXCEPTION 'Universal content search projection linkage cannot be attached or removed directly';
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."category" IS DISTINCT FROM OLD."category"
     OR NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."is_enabled" IS DISTINCT FROM OLD."is_enabled"
     OR NEW."visibility" IS DISTINCT FROM OLD."visibility"
     OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
     OR NEW."authorship" IS DISTINCT FROM OLD."authorship"
     OR NEW."source_name" IS DISTINCT FROM OLD."source_name"
     OR NEW."source_url" IS DISTINCT FROM OLD."source_url"
     OR NEW."source_package_id" IS DISTINCT FROM OLD."source_package_id"
     OR NEW."content_module_id" IS DISTINCT FROM OLD."content_module_id"
     OR NEW."content_revision_id" IS DISTINCT FROM OLD."content_revision_id"
     OR NEW."content_publication_id" IS DISTINCT FROM OLD."content_publication_id" THEN
    IF pg_trigger_depth() <= 1 OR NOT EXISTS (
      SELECT 1
        FROM "content_module_publications" publication
        JOIN "content_module_revisions" revision
          ON revision."id" = publication."revision_id"
         AND revision."tenant_id" = publication."tenant_id"
         AND revision."venue_id" = publication."venue_id"
         AND revision."module_id" = publication."module_id"
        LEFT JOIN "policy_content" policy ON policy."revision_id" = revision."id"
        LEFT JOIN "operational_fact_content" fact ON fact."revision_id" = revision."id"
        LEFT JOIN "event_content" event ON event."revision_id" = revision."id"
        LEFT JOIN "service_content" service ON service."revision_id" = revision."id"
        LEFT JOIN "item_content" item ON item."revision_id" = revision."id"
       WHERE publication."id" = NEW."content_publication_id"
         AND publication."tenant_id" = NEW."tenant_id"
         AND publication."venue_id" = NEW."venue_id"
         AND publication."module_id" = NEW."content_module_id"
         AND publication."revision_id" = NEW."content_revision_id"
         AND NOT EXISTS (
           SELECT 1 FROM "content_module_publications" newer
            WHERE newer."tenant_id" = publication."tenant_id"
              AND newer."venue_id" = publication."venue_id"
              AND newer."module_id" = publication."module_id"
              AND newer."event_order" > publication."event_order"
         )
         AND (
           (
             publication."action" = 'PUBLISH'
             AND revision."audience" = 'PUBLIC'
             AND revision."kind" <> 'RELATIONSHIP'
             AND NEW."is_enabled" = TRUE
             AND NEW."title" = CASE revision."kind"
               WHEN 'POLICY' THEN policy."title" WHEN 'OPERATIONAL_FACT' THEN fact."label"
               WHEN 'EVENT' THEN event."name" WHEN 'SERVICE' THEN service."name"
               WHEN 'ITEM' THEN item."name" END
             AND NEW."content" = CASE revision."kind"
               WHEN 'POLICY' THEN policy."rule"
               WHEN 'OPERATIONAL_FACT' THEN fact."value"
               WHEN 'EVENT' THEN concat_ws(E'\n', event."description", 'Starts: ' || event."starts_at"::TEXT, 'Ends: ' || coalesce(event."ends_at"::TEXT, 'not specified'))
               WHEN 'SERVICE' THEN concat_ws(E'\n', service."description", service."availability")
               WHEN 'ITEM' THEN concat_ws(E'\n', item."description", 'Item type: ' || item."item_type") END
             AND NEW."category" = revision."kind"::TEXT
             AND NEW."visibility" = 'PUBLIC'
             AND NEW."source_type" = 'UNIVERSAL_CONTENT'
             AND NEW."authorship" = 'UNKNOWN'
           )
           OR (
             (publication."action" = 'WITHDRAW' OR revision."audience" <> 'PUBLIC' OR revision."kind" = 'RELATIONSHIP')
             AND NEW."is_enabled" = FALSE
             AND NEW."title" IS NOT DISTINCT FROM OLD."title"
             AND NEW."category" IS NOT DISTINCT FROM OLD."category"
             AND NEW."content" IS NOT DISTINCT FROM OLD."content"
           )
         )
         AND NEW."embedding" IS NULL
    ) THEN
      RAISE EXCEPTION 'Universal content search projections are publication-ledger derived and cannot be edited directly';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION sync_universal_content_search_projection_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM sync_universal_content_search_projection(NEW."id");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_module_publication_search_projection_trigger"
AFTER INSERT ON "content_module_publications"
FOR EACH ROW EXECUTE FUNCTION sync_universal_content_search_projection_trigger();

DO $$
DECLARE
  latest RECORD;
BEGIN
  FOR latest IN
    SELECT DISTINCT ON (publication."module_id", publication."tenant_id", publication."venue_id")
           publication."id"
      FROM "content_module_publications" publication
     ORDER BY publication."module_id", publication."tenant_id", publication."venue_id", publication."event_order" DESC
  LOOP
    PERFORM sync_universal_content_search_projection(latest."id");
  END LOOP;
END;
$$;

CREATE TRIGGER "venue_knowledge_entry_projection_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "venue_knowledge_entries"
FOR EACH ROW EXECUTE FUNCTION guard_universal_content_search_projection();
