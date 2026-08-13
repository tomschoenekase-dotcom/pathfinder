-- Add strict typed ITEM content without rewriting legacy rows.
CREATE TABLE "item_content" (
  "revision_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "kind" "NormalizedContentModuleKind" NOT NULL DEFAULT 'ITEM',
  "name" VARCHAR(200) NOT NULL,
  "description" VARCHAR(10000),
  "place_id" TEXT,
  "item_type" VARCHAR(100) NOT NULL,
  CONSTRAINT "item_content_pkey" PRIMARY KEY ("revision_id"),
  CONSTRAINT "item_content_kind_check" CHECK ("kind" = 'ITEM'),
  CONSTRAINT "item_content_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "item_content_description_check" CHECK ("description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 10000),
  CONSTRAINT "item_content_type_check" CHECK (char_length(btrim("item_type")) BETWEEN 1 AND 100),
  CONSTRAINT "item_content_revision_scope_key" UNIQUE ("revision_id", "tenant_id", "venue_id", "kind")
);

ALTER TABLE "item_content" ADD CONSTRAINT "item_content_revision_scope_fkey"
  FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind")
  REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "item_content" ADD CONSTRAINT "item_content_place_scope_fkey"
  FOREIGN KEY ("place_id", "tenant_id", "venue_id")
  REFERENCES "places"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "item_content_scope_name_idx" ON "item_content"("tenant_id", "venue_id", "name");

CREATE FUNCTION public.pathfinder_require_item_content_sidecar() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  sidecar_count integer;
BEGIN
  IF TG_TABLE_NAME = 'content_module_revisions' AND NEW.kind = 'ITEM' THEN
    SELECT count(*) INTO sidecar_count
    FROM public.item_content AS item
    WHERE item.revision_id = NEW.id
      AND item.tenant_id = NEW.tenant_id
      AND item.venue_id = NEW.venue_id
      AND item.kind = NEW.kind;
    IF sidecar_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'ITEM revision requires exactly one typed sidecar';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER content_module_revisions_require_item_sidecar
AFTER INSERT ON "content_module_revisions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.pathfinder_require_item_content_sidecar();

CREATE TRIGGER item_content_append_only
BEFORE UPDATE OR DELETE ON "item_content"
FOR EACH ROW EXECUTE FUNCTION public.pathfinder_reject_content_module_mutation();

CREATE TRIGGER item_content_no_truncate
BEFORE TRUNCATE ON "item_content"
FOR EACH STATEMENT EXECUTE FUNCTION public.pathfinder_reject_content_module_mutation();
