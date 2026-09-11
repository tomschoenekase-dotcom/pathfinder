CREATE TABLE "knowledge_proposal_universal_content_handoffs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "proposal_id" UUID NOT NULL,
  "module_id" TEXT NOT NULL,
  "module_kind" "NormalizedContentModuleKind" NOT NULL,
  "revision_id" TEXT NOT NULL,
  "classification" VARCHAR(32) NOT NULL,
  "relation" VARCHAR(32) NOT NULL,
  "preview_hash" CHAR(64) NOT NULL,
  "draft_hash" CHAR(64) NOT NULL,
  "proposal_updated_at" TIMESTAMP(3) NOT NULL,
  "expected_base_revision_id" TEXT,
  "expected_base_version" INTEGER,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_proposal_universal_content_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_proposal_universal_handoffs_shape_check" CHECK (
    "classification" IN ('ADDITION', 'CORRECTION', 'SUPERSESSION')
    AND "relation" IN ('NEW_FACT', 'CORRECTS', 'SUPERSEDES')
    AND (
      ("classification" = 'ADDITION' AND "relation" = 'NEW_FACT' AND "expected_base_revision_id" IS NULL AND "expected_base_version" IS NULL)
      OR
      ("classification" = 'CORRECTION' AND "relation" = 'CORRECTS' AND "expected_base_revision_id" IS NOT NULL AND "expected_base_version" > 0)
      OR
      ("classification" = 'SUPERSESSION' AND "relation" = 'SUPERSEDES' AND "expected_base_revision_id" IS NOT NULL AND "expected_base_version" > 0)
    )
    AND "preview_hash" ~ '^[a-f0-9]{64}$'
    AND "draft_hash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "knowledge_proposal_universal_handoffs_proposal_scope_key"
  ON "knowledge_proposal_universal_content_handoffs" ("proposal_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "knowledge_proposal_universal_handoffs_revision_scope_key"
  ON "knowledge_proposal_universal_content_handoffs" ("revision_id", "tenant_id", "venue_id");
CREATE INDEX "knowledge_proposal_universal_handoffs_scope_created_idx"
  ON "knowledge_proposal_universal_content_handoffs" ("tenant_id", "venue_id", "created_at");

ALTER TABLE "knowledge_proposal_universal_content_handoffs"
  ADD CONSTRAINT "knowledge_proposal_universal_handoffs_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_proposal_universal_handoffs_venue_fkey"
    FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues" ("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_proposal_universal_handoffs_proposal_fkey"
    FOREIGN KEY ("proposal_id", "tenant_id", "venue_id") REFERENCES "knowledge_change_proposals" ("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_proposal_universal_handoffs_module_fkey"
    FOREIGN KEY ("module_id", "tenant_id", "venue_id", "module_kind") REFERENCES "content_module_identities" ("id", "tenant_id", "venue_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_proposal_universal_handoffs_revision_fkey"
    FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "module_id", "module_kind") REFERENCES "content_module_revisions" ("id", "tenant_id", "venue_id", "module_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "knowledge_proposal_universal_handoffs_base_revision_fkey"
    FOREIGN KEY ("expected_base_revision_id", "tenant_id", "venue_id", "module_id", "module_kind") REFERENCES "content_module_revisions" ("id", "tenant_id", "venue_id", "module_id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION guard_knowledge_proposal_universal_content_handoff()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  produced_version INTEGER;
  base_version INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Semantic universal-content handoffs are immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "knowledge_change_proposals" proposal
     WHERE proposal."id" = NEW."proposal_id"
       AND proposal."tenant_id" = NEW."tenant_id"
       AND proposal."venue_id" = NEW."venue_id"
       AND proposal."status" = 'APPROVED'
       AND proposal."updated_at" = NEW."proposal_updated_at"
  ) THEN
    RAISE EXCEPTION 'Semantic universal-content handoff requires the exact approved proposal version';
  END IF;

  SELECT revision."version" INTO STRICT produced_version
    FROM "content_module_revisions" revision
   WHERE revision."id" = NEW."revision_id"
     AND revision."tenant_id" = NEW."tenant_id"
     AND revision."venue_id" = NEW."venue_id"
     AND revision."module_id" = NEW."module_id"
     AND revision."kind" = NEW."module_kind";

  IF NEW."expected_base_revision_id" IS NULL THEN
    IF produced_version <> 1 THEN
      RAISE EXCEPTION 'Semantic addition must hand off the first module revision';
    END IF;
  ELSE
    SELECT revision."version" INTO STRICT base_version
      FROM "content_module_revisions" revision
     WHERE revision."id" = NEW."expected_base_revision_id"
       AND revision."tenant_id" = NEW."tenant_id"
       AND revision."venue_id" = NEW."venue_id"
       AND revision."module_id" = NEW."module_id"
       AND revision."kind" = NEW."module_kind";
    IF base_version <> NEW."expected_base_version" OR produced_version <> base_version + 1 THEN
      RAISE EXCEPTION 'Semantic handoff base version does not match its exact prior revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_proposal_universal_content_handoff_guard_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_proposal_universal_content_handoffs"
FOR EACH ROW EXECUTE FUNCTION guard_knowledge_proposal_universal_content_handoff();
