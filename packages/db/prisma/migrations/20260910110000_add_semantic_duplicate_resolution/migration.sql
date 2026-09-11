CREATE TABLE "semantic_duplicate_resolutions" (
 "id" UUID PRIMARY KEY, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
 "proposal_id" UUID NOT NULL, "proposal_updated_at" TIMESTAMP(3) NOT NULL,
 "preview_hash" CHAR(64) NOT NULL, "target_knowledge_entry_id" TEXT NOT NULL,
 "target_snapshot_hash" CHAR(64) NOT NULL, "input_hash" CHAR(64) NOT NULL,
 "relation" VARCHAR(16) NOT NULL, "desired" JSONB NOT NULL,
 "source_evidence" JSONB NOT NULL, "resolution_note" VARCHAR(2000) NOT NULL,
 "created_by" VARCHAR(191) NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "semantic_duplicate_resolution_hash_check" CHECK (
  "preview_hash" ~ '^[a-f0-9]{64}$'
  AND "target_snapshot_hash" ~ '^[a-f0-9]{64}$'
  AND "input_hash" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "semantic_duplicate_resolution_shape_check" CHECK (
  "relation" IN ('NEW_FACT','CORRECTS','SUPERSEDES')
  AND jsonb_typeof("desired") = 'object'
  AND jsonb_typeof("source_evidence") = 'array'
  AND jsonb_array_length("source_evidence") BETWEEN 1 AND 20
  AND length(btrim("resolution_note")) > 0
  AND length(btrim("created_by")) > 0),
 CONSTRAINT "semantic_duplicate_resolution_proposal_fkey"
  FOREIGN KEY ("proposal_id","tenant_id","venue_id")
  REFERENCES "knowledge_change_proposals"("id","tenant_id","venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "semantic_duplicate_resolution_target_fkey"
  FOREIGN KEY ("target_knowledge_entry_id","tenant_id","venue_id")
  REFERENCES "venue_knowledge_entries"("id","tenant_id","venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "semantic_duplicate_resolution_proposal_key"
 ON "semantic_duplicate_resolutions"("proposal_id","tenant_id","venue_id");
CREATE INDEX "semantic_duplicate_resolution_target_idx"
 ON "semantic_duplicate_resolutions"("tenant_id","venue_id","target_knowledge_entry_id");

CREATE FUNCTION guard_semantic_duplicate_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Semantic duplicate resolutions are append-only';
 END IF;
 PERFORM 1
 FROM "knowledge_change_proposals" p
 WHERE p.id = NEW.proposal_id
  AND p.tenant_id = NEW.tenant_id
  AND p.venue_id = NEW.venue_id
  AND p.status = 'APPROVED'
  AND p.updated_at = NEW.proposal_updated_at
  AND (p.target_knowledge_entry_id IS NULL
    OR p.target_knowledge_entry_id = NEW.target_knowledge_entry_id)
 FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Duplicate resolution requires the exact approved targeted proposal';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER "semantic_duplicate_resolution_guard"
 BEFORE INSERT OR UPDATE OR DELETE ON "semantic_duplicate_resolutions"
 FOR EACH ROW EXECUTE FUNCTION guard_semantic_duplicate_resolution();
