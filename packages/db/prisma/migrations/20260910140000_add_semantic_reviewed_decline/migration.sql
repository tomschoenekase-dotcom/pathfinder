BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

LOCK TABLE "knowledge_change_proposals" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "semantic_proposal_outcome_claims" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "semantic_proposal_outcome_claims"
  DROP CONSTRAINT "semantic_proposal_outcome_claims_kind_check",
  ADD CONSTRAINT "semantic_proposal_outcome_claims_kind_check"
    CHECK ("outcome_kind" IN ('DUPLICATE', 'CONTENT', 'DECLINED'));

CREATE TABLE "semantic_reviewed_declines" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "proposal_id" UUID NOT NULL,
  "source_proposal_id" UUID NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "support_request_version" INTEGER NOT NULL,
  "proposal_updated_at" TIMESTAMP(3) NOT NULL,
  "reviewed_proposal_updated_at" TIMESTAMP(3) NOT NULL,
  "reviewed_at" TIMESTAMP(3) NOT NULL,
  "review_note_hash" CHAR(64) NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "source_evidence" JSONB NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semantic_reviewed_declines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_reviewed_declines_hashes_check" CHECK (
    "review_note_hash" ~ '^[0-9a-f]{64}$' AND "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "semantic_reviewed_declines_actor_check" CHECK (length(btrim("created_by")) > 0),
  CONSTRAINT "semantic_reviewed_declines_version_check" CHECK ("support_request_version" >= 1),
  CONSTRAINT "semantic_reviewed_declines_time_check" CHECK (
    "proposal_updated_at" <= "reviewed_at" AND "reviewed_at" <= "reviewed_proposal_updated_at"
  ),
  CONSTRAINT "semantic_reviewed_declines_evidence_check" CHECK (
    jsonb_typeof("source_evidence") = 'array'
    AND jsonb_array_length("source_evidence") BETWEEN 1 AND 20
  ),
  CONSTRAINT "semantic_reviewed_decline_proposal_fkey" FOREIGN KEY ("proposal_id", "tenant_id", "venue_id")
    REFERENCES "knowledge_change_proposals"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "semantic_reviewed_decline_source_proposal_fkey" FOREIGN KEY ("source_proposal_id", "tenant_id", "venue_id")
    REFERENCES "knowledge_change_proposals"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "semantic_reviewed_decline_support_request_fkey" FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")
    REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "semantic_reviewed_decline_proposal_key"
  ON "semantic_reviewed_declines"("proposal_id", "tenant_id", "venue_id");
CREATE INDEX "semantic_reviewed_decline_scope_idx"
  ON "semantic_reviewed_declines"("tenant_id", "venue_id", "proposal_id");

CREATE FUNCTION guard_semantic_reviewed_decline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Semantic reviewed declines are append-only';
  END IF;

  PERFORM 1 FROM "knowledge_change_proposals" proposal
  WHERE proposal."id" = NEW."proposal_id"
    AND proposal."tenant_id" = NEW."tenant_id"
    AND proposal."venue_id" = NEW."venue_id"
    AND proposal."status" = 'REJECTED'
    AND proposal."updated_at" = NEW."reviewed_proposal_updated_at"
    AND proposal."reviewer_id" = NEW."created_by"
    AND proposal."reviewed_at" = NEW."reviewed_at"
    AND encode(sha256(convert_to(proposal."review_note", 'UTF8')), 'hex') = NEW."review_note_hash"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewed decline requires the exact rejected proposal review';
  END IF;

  PERFORM 1 FROM "knowledge_change_proposals" source
  WHERE source."id" = NEW."source_proposal_id"
    AND source."tenant_id" = NEW."tenant_id"
    AND source."venue_id" = NEW."venue_id"
    AND source."support_request_id" = NEW."support_request_id"
    AND source."support_request_version" = NEW."support_request_version"
    AND NOT EXISTS (
      SELECT 1 FROM "semantic_conflict_resolutions" previous
      WHERE previous."replacement_proposal_id" = source."id"
        AND previous."tenant_id" = NEW."tenant_id" AND previous."venue_id" = NEW."venue_id"
    )
    AND (source."id" = NEW."proposal_id" OR EXISTS (
      SELECT 1 FROM "semantic_conflict_resolutions" replacement
      WHERE replacement."proposal_id" = source."id"
        AND replacement."replacement_proposal_id" = NEW."proposal_id"
        AND replacement."tenant_id" = NEW."tenant_id" AND replacement."venue_id" = NEW."venue_id"
        AND replacement."outcome" = 'PROPOSE_REPLACEMENT'
    ))
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reviewed decline requires its exact direct or one-hop support source';
  END IF;

  PERFORM claim_semantic_proposal_outcome(NEW."proposal_id", NEW."tenant_id", NEW."venue_id", 'DECLINED');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "semantic_reviewed_declines_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "semantic_reviewed_declines"
  FOR EACH ROW EXECUTE FUNCTION guard_semantic_reviewed_decline();
CREATE TRIGGER "semantic_reviewed_declines_no_truncate"
  BEFORE TRUNCATE ON "semantic_reviewed_declines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_semantic_proposal_outcome_claim_mutation();

COMMIT;
