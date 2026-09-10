CREATE TABLE "semantic_proposal_outcome_claims" (
  "proposal_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "outcome_kind" VARCHAR(16) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semantic_proposal_outcome_claims_pkey"
    PRIMARY KEY ("proposal_id", "tenant_id", "venue_id"),
  CONSTRAINT "semantic_proposal_outcome_claims_kind_check"
    CHECK ("outcome_kind" IN ('DUPLICATE', 'CONTENT')),
  CONSTRAINT "semantic_proposal_outcome_claims_proposal_fkey"
    FOREIGN KEY ("proposal_id", "tenant_id", "venue_id")
    REFERENCES "knowledge_change_proposals"("id", "tenant_id", "venue_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "semantic_duplicate_resolutions" duplicate
    WHERE EXISTS (
      SELECT 1 FROM "knowledge_proposal_package_handoffs" outcome
      WHERE (outcome."proposal_id", outcome."tenant_id", outcome."venue_id") =
        (duplicate."proposal_id", duplicate."tenant_id", duplicate."venue_id")
      UNION ALL
      SELECT 1 FROM "knowledge_proposal_operational_update_handoffs" outcome
      WHERE (outcome."proposal_id", outcome."tenant_id", outcome."venue_id") =
        (duplicate."proposal_id", duplicate."tenant_id", duplicate."venue_id")
      UNION ALL
      SELECT 1 FROM "knowledge_proposal_universal_content_handoffs" outcome
      WHERE (outcome."proposal_id", outcome."tenant_id", outcome."venue_id") =
        (duplicate."proposal_id", duplicate."tenant_id", duplicate."venue_id")
      UNION ALL
      SELECT 1 FROM "legacy_knowledge_universal_content_adoptions" outcome
      WHERE (outcome."proposal_id", outcome."tenant_id", outcome."venue_id") =
        (duplicate."proposal_id", duplicate."tenant_id", duplicate."venue_id")
      UNION ALL
      SELECT 1 FROM "semantic_conflict_resolutions" outcome
      WHERE (outcome."proposal_id", outcome."tenant_id", outcome."venue_id") =
        (duplicate."proposal_id", duplicate."tenant_id", duplicate."venue_id")
    )
  ) THEN
    RAISE EXCEPTION 'Existing proposal has contradictory duplicate and content outcomes';
  END IF;
END;
$$;

INSERT INTO "semantic_proposal_outcome_claims"
  ("proposal_id", "tenant_id", "venue_id", "outcome_kind")
SELECT duplicate."proposal_id", duplicate."tenant_id", duplicate."venue_id", 'DUPLICATE'
FROM "semantic_duplicate_resolutions" duplicate;

INSERT INTO "semantic_proposal_outcome_claims"
  ("proposal_id", "tenant_id", "venue_id", "outcome_kind")
SELECT DISTINCT outcome."proposal_id", outcome."tenant_id", outcome."venue_id", 'CONTENT'
FROM (
  SELECT "proposal_id", "tenant_id", "venue_id" FROM "knowledge_proposal_package_handoffs"
  UNION ALL
  SELECT "proposal_id", "tenant_id", "venue_id" FROM "knowledge_proposal_operational_update_handoffs"
  UNION ALL
  SELECT "proposal_id", "tenant_id", "venue_id" FROM "knowledge_proposal_universal_content_handoffs"
  UNION ALL
  SELECT "proposal_id", "tenant_id", "venue_id" FROM "legacy_knowledge_universal_content_adoptions"
  UNION ALL
  SELECT "proposal_id", "tenant_id", "venue_id" FROM "semantic_conflict_resolutions"
) outcome;

CREATE FUNCTION reject_semantic_proposal_outcome_claim_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Semantic proposal outcome claims are immutable';
END;
$$;
CREATE TRIGGER "semantic_proposal_outcome_claims_immutable"
  BEFORE UPDATE OR DELETE ON "semantic_proposal_outcome_claims"
  FOR EACH ROW EXECUTE FUNCTION reject_semantic_proposal_outcome_claim_mutation();
CREATE TRIGGER "semantic_proposal_outcome_claims_no_truncate"
  BEFORE TRUNCATE ON "semantic_proposal_outcome_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_semantic_proposal_outcome_claim_mutation();

CREATE FUNCTION claim_semantic_proposal_outcome(
  claim_proposal_id UUID,
  claim_tenant_id TEXT,
  claim_venue_id TEXT,
  requested_kind TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  claimed_kind TEXT;
BEGIN
  INSERT INTO "semantic_proposal_outcome_claims"
    ("proposal_id", "tenant_id", "venue_id", "outcome_kind")
  VALUES (claim_proposal_id, claim_tenant_id, claim_venue_id, requested_kind)
  ON CONFLICT ("proposal_id", "tenant_id", "venue_id") DO NOTHING;

  SELECT claim."outcome_kind" INTO claimed_kind
  FROM "semantic_proposal_outcome_claims" claim
  WHERE claim."proposal_id" = claim_proposal_id
    AND claim."tenant_id" = claim_tenant_id
    AND claim."venue_id" = claim_venue_id
  FOR UPDATE;

  IF claimed_kind IS NULL THEN
    RAISE EXCEPTION 'Proposal outcome claim could not be observed after arbitration';
  END IF;
  IF claimed_kind <> requested_kind THEN
    RAISE EXCEPTION 'Proposal already has an incompatible outcome claim';
  END IF;
END;
$$;

-- Serialize every terminal proposal outcome through both the exact proposal row
-- and its immutable claim so old repeatable-read snapshots cannot admit both kinds.
CREATE FUNCTION guard_semantic_duplicate_exclusion_on_outcome() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM "knowledge_change_proposals" proposal
  WHERE proposal."id" = NEW."proposal_id"
    AND proposal."tenant_id" = NEW."tenant_id"
    AND proposal."venue_id" = NEW."venue_id"
  FOR UPDATE;

  PERFORM claim_semantic_proposal_outcome(
    NEW."proposal_id", NEW."tenant_id", NEW."venue_id", 'CONTENT'
  );

  IF EXISTS (
    SELECT 1
    FROM "semantic_duplicate_resolutions" duplicate
    WHERE duplicate."proposal_id" = NEW."proposal_id"
      AND duplicate."tenant_id" = NEW."tenant_id"
      AND duplicate."venue_id" = NEW."venue_id"
  ) THEN
    RAISE EXCEPTION 'Proposal already has a semantic duplicate resolution';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_proposal_package_handoff_duplicate_exclusion"
  BEFORE INSERT ON "knowledge_proposal_package_handoffs"
  FOR EACH ROW EXECUTE FUNCTION guard_semantic_duplicate_exclusion_on_outcome();
CREATE TRIGGER "knowledge_proposal_operational_handoff_duplicate_exclusion"
  BEFORE INSERT ON "knowledge_proposal_operational_update_handoffs"
  FOR EACH ROW EXECUTE FUNCTION guard_semantic_duplicate_exclusion_on_outcome();
CREATE TRIGGER "knowledge_proposal_universal_handoff_duplicate_exclusion"
  BEFORE INSERT ON "knowledge_proposal_universal_content_handoffs"
  FOR EACH ROW EXECUTE FUNCTION guard_semantic_duplicate_exclusion_on_outcome();
CREATE TRIGGER "legacy_knowledge_adoption_duplicate_exclusion"
  BEFORE INSERT ON "legacy_knowledge_universal_content_adoptions"
  FOR EACH ROW EXECUTE FUNCTION guard_semantic_duplicate_exclusion_on_outcome();
CREATE TRIGGER "semantic_conflict_resolution_duplicate_exclusion"
  BEFORE INSERT ON "semantic_conflict_resolutions"
  FOR EACH ROW EXECUTE FUNCTION guard_semantic_duplicate_exclusion_on_outcome();

CREATE OR REPLACE FUNCTION guard_semantic_duplicate_resolution() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Semantic duplicate resolutions are append-only';
  END IF;

  PERFORM 1
  FROM "knowledge_change_proposals" proposal
  WHERE proposal."id" = NEW."proposal_id"
    AND proposal."tenant_id" = NEW."tenant_id"
    AND proposal."venue_id" = NEW."venue_id"
    AND proposal."status" = 'APPROVED'
    AND proposal."updated_at" = NEW."proposal_updated_at"
    AND (
      proposal."target_knowledge_entry_id" IS NULL
      OR proposal."target_knowledge_entry_id" = NEW."target_knowledge_entry_id"
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Duplicate resolution requires the exact approved targeted proposal';
  END IF;

  PERFORM claim_semantic_proposal_outcome(
    NEW."proposal_id", NEW."tenant_id", NEW."venue_id", 'DUPLICATE'
  );

  IF EXISTS (
      SELECT 1 FROM "knowledge_proposal_package_handoffs" outcome
      WHERE outcome."proposal_id" = NEW."proposal_id"
        AND outcome."tenant_id" = NEW."tenant_id"
        AND outcome."venue_id" = NEW."venue_id"
    ) OR EXISTS (
      SELECT 1 FROM "knowledge_proposal_operational_update_handoffs" outcome
      WHERE outcome."proposal_id" = NEW."proposal_id"
        AND outcome."tenant_id" = NEW."tenant_id"
        AND outcome."venue_id" = NEW."venue_id"
    ) OR EXISTS (
      SELECT 1 FROM "knowledge_proposal_universal_content_handoffs" outcome
      WHERE outcome."proposal_id" = NEW."proposal_id"
        AND outcome."tenant_id" = NEW."tenant_id"
        AND outcome."venue_id" = NEW."venue_id"
    ) OR EXISTS (
      SELECT 1 FROM "legacy_knowledge_universal_content_adoptions" outcome
      WHERE outcome."proposal_id" = NEW."proposal_id"
        AND outcome."tenant_id" = NEW."tenant_id"
        AND outcome."venue_id" = NEW."venue_id"
    ) OR EXISTS (
      SELECT 1 FROM "semantic_conflict_resolutions" outcome
      WHERE outcome."proposal_id" = NEW."proposal_id"
        AND outcome."tenant_id" = NEW."tenant_id"
        AND outcome."venue_id" = NEW."venue_id"
    ) THEN
    RAISE EXCEPTION 'Proposal already has a competing fulfillment outcome';
  END IF;

  RETURN NEW;
END;
$$;
