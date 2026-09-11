CREATE TABLE "legacy_knowledge_universal_content_adoptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "proposal_id" UUID NOT NULL,
  "legacy_knowledge_entry_id" TEXT NOT NULL,
  "module_id" TEXT NOT NULL,
  "module_kind" "NormalizedContentModuleKind" NOT NULL,
  "revision_id" TEXT NOT NULL,
  "proposal_updated_at" TIMESTAMP(3) NOT NULL,
  "legacy_knowledge_updated_at" TIMESTAMP(3) NOT NULL,
  "legacy_snapshot" JSONB NOT NULL,
  "legacy_snapshot_hash" CHAR(64) NOT NULL,
  "draft_hash" CHAR(64) NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legacy_knowledge_universal_content_adoptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legacy_knowledge_adoptions_hash_shape_check" CHECK (
    "legacy_snapshot_hash" ~ '^[a-f0-9]{64}$' AND "draft_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "legacy_knowledge_adoptions_proposal_scope_key" UNIQUE ("proposal_id", "tenant_id", "venue_id"),
  CONSTRAINT "legacy_knowledge_adoptions_legacy_scope_key" UNIQUE ("legacy_knowledge_entry_id", "tenant_id", "venue_id"),
  CONSTRAINT "legacy_knowledge_adoptions_module_scope_key" UNIQUE ("module_id", "tenant_id", "venue_id"),
  CONSTRAINT "legacy_knowledge_adoptions_id_scope_key" UNIQUE ("id", "tenant_id", "venue_id", "module_id"),
  CONSTRAINT "legacy_knowledge_adoptions_proposal_fkey" FOREIGN KEY ("proposal_id", "tenant_id", "venue_id") REFERENCES "knowledge_change_proposals" ("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "legacy_knowledge_adoptions_legacy_fkey" FOREIGN KEY ("legacy_knowledge_entry_id", "tenant_id", "venue_id") REFERENCES "venue_knowledge_entries" ("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "legacy_knowledge_adoptions_module_fkey" FOREIGN KEY ("module_id", "tenant_id", "venue_id", "module_kind") REFERENCES "content_module_identities" ("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "legacy_knowledge_adoptions_revision_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "module_id", "module_kind") REFERENCES "content_module_revisions" ("id", "tenant_id", "venue_id", "module_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "legacy_knowledge_adoptions_scope_created_idx" ON "legacy_knowledge_universal_content_adoptions" ("tenant_id", "venue_id", "created_at");

CREATE TABLE "legacy_knowledge_adoption_activations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "adoption_id" UUID NOT NULL,
  "module_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "publication_id" TEXT NOT NULL,
  "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legacy_knowledge_adoption_activations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legacy_knowledge_adoption_activations_scope_key" UNIQUE ("adoption_id", "tenant_id", "venue_id"),
  CONSTRAINT "legacy_knowledge_adoption_activations_adoption_scope_key" UNIQUE ("adoption_id", "tenant_id", "venue_id", "module_id"),
  CONSTRAINT "legacy_knowledge_adoption_activations_publication_key" UNIQUE ("publication_id"),
  CONSTRAINT "legacy_knowledge_adoption_activations_publication_scope_key" UNIQUE ("publication_id", "tenant_id", "venue_id", "revision_id", "module_id"),
  CONSTRAINT "legacy_knowledge_adoption_activations_adoption_fkey" FOREIGN KEY ("adoption_id", "tenant_id", "venue_id", "module_id") REFERENCES "legacy_knowledge_universal_content_adoptions" ("id", "tenant_id", "venue_id", "module_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "legacy_knowledge_adoption_activations_publication_fkey" FOREIGN KEY ("publication_id", "tenant_id", "venue_id", "revision_id", "module_id") REFERENCES "content_module_publications" ("id", "tenant_id", "venue_id", "revision_id", "module_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "legacy_knowledge_adoption_activations_scope_created_idx" ON "legacy_knowledge_adoption_activations" ("tenant_id", "venue_id", "activated_at");

CREATE FUNCTION guard_legacy_knowledge_adoption_receipt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE revision_version INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Legacy knowledge adoption receipts are append-only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "knowledge_change_proposals" proposal
     WHERE proposal."id" = NEW."proposal_id" AND proposal."tenant_id" = NEW."tenant_id"
       AND proposal."venue_id" = NEW."venue_id" AND proposal."status" = 'APPROVED'
       AND proposal."updated_at" = NEW."proposal_updated_at"
       AND proposal."target_knowledge_entry_id" = NEW."legacy_knowledge_entry_id"
  ) THEN RAISE EXCEPTION 'Legacy adoption requires the exact approved targeted proposal'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "venue_knowledge_entries" entry
     WHERE entry."id" = NEW."legacy_knowledge_entry_id" AND entry."tenant_id" = NEW."tenant_id"
       AND entry."venue_id" = NEW."venue_id" AND entry."updated_at" = NEW."legacy_knowledge_updated_at"
       AND entry."content_module_id" IS NULL AND entry."content_revision_id" IS NULL
       AND entry."content_publication_id" IS NULL
  ) THEN RAISE EXCEPTION 'Legacy adoption source is stale, scoped elsewhere, or already native'; END IF;
  SELECT revision."version" INTO revision_version FROM "content_module_revisions" revision
   WHERE revision."id" = NEW."revision_id" AND revision."tenant_id" = NEW."tenant_id"
     AND revision."venue_id" = NEW."venue_id" AND revision."module_id" = NEW."module_id"
     AND revision."kind" = NEW."module_kind";
  IF revision_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Legacy adoption must point to the first native revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "legacy_knowledge_adoption_receipt_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "legacy_knowledge_universal_content_adoptions"
FOR EACH ROW EXECUTE FUNCTION guard_legacy_knowledge_adoption_receipt();

CREATE FUNCTION activate_legacy_knowledge_adoption_on_publish()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."action" = 'PUBLISH' THEN
    INSERT INTO "legacy_knowledge_adoption_activations" (
      "tenant_id", "venue_id", "adoption_id", "module_id", "revision_id", "publication_id"
    )
    SELECT adoption."tenant_id", adoption."venue_id", adoption."id", adoption."module_id",
           NEW."revision_id", NEW."id"
      FROM "legacy_knowledge_universal_content_adoptions" adoption
     WHERE adoption."tenant_id" = NEW."tenant_id" AND adoption."venue_id" = NEW."venue_id"
       AND adoption."module_id" = NEW."module_id"
    ON CONFLICT ("adoption_id", "tenant_id", "venue_id") DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "legacy_knowledge_adoption_publication_activation"
AFTER INSERT ON "content_module_publications"
FOR EACH ROW EXECUTE FUNCTION activate_legacy_knowledge_adoption_on_publish();

CREATE FUNCTION guard_legacy_knowledge_adoption_activation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Legacy knowledge adoption activations are append-only'; END IF;
  IF pg_trigger_depth() <= 1 THEN RAISE EXCEPTION 'Legacy knowledge adoption activates only through explicit publication'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "legacy_knowledge_adoption_activation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "legacy_knowledge_adoption_activations"
FOR EACH ROW EXECUTE FUNCTION guard_legacy_knowledge_adoption_activation();

CREATE FUNCTION guard_adopted_legacy_knowledge_source()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "legacy_knowledge_universal_content_adoptions" adoption
     WHERE adoption."tenant_id" = OLD."tenant_id"
       AND adoption."venue_id" = OLD."venue_id"
       AND adoption."legacy_knowledge_entry_id" = OLD."id"
  ) THEN
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - 'embedding') = (to_jsonb(OLD) - 'embedding') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An adopted legacy knowledge source is immutable historical evidence';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "adopted_legacy_knowledge_source_guard"
BEFORE UPDATE OR DELETE ON "venue_knowledge_entries"
FOR EACH ROW EXECUTE FUNCTION guard_adopted_legacy_knowledge_source();
