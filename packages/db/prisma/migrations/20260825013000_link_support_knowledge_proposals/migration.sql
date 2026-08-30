-- Bind one reviewed content-correction request version to one separately
-- reviewable knowledge proposal. The bridge is provenance only: it grants no
-- publication or canonical-content authority.
ALTER TABLE "knowledge_change_proposals"
  ADD COLUMN "support_request_id" TEXT,
  ADD COLUMN "support_request_version" INTEGER;

ALTER TABLE "knowledge_change_proposals"
  ADD CONSTRAINT "knowledge_proposals_support_source_pair_check"
  CHECK (
    ("support_request_id" IS NULL AND "support_request_version" IS NULL)
    OR
    ("support_request_id" IS NOT NULL AND "support_request_version" > 0)
  );

ALTER TABLE "knowledge_change_proposals"
  ADD CONSTRAINT "knowledge_proposals_support_request_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")
  REFERENCES "support_requests"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_change_proposals"
  ADD CONSTRAINT "knowledge_proposals_support_event_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id", "support_request_version")
  REFERENCES "support_request_audit_events"("support_request_id", "tenant_id", "venue_id", "request_version")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "knowledge_proposals_support_version_key"
  ON "knowledge_change_proposals"("support_request_id", "tenant_id", "venue_id", "support_request_version");

CREATE INDEX "knowledge_proposals_support_source_idx"
  ON "knowledge_change_proposals"("tenant_id", "venue_id", "support_request_id", "support_request_version");

CREATE OR REPLACE FUNCTION prevent_support_knowledge_proposal_source_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW."support_request_id" IS DISTINCT FROM OLD."support_request_id"
    OR NEW."support_request_version" IS DISTINCT FROM OLD."support_request_version"
    OR (
      OLD."support_request_id" IS NOT NULL
      AND (
        NEW."target_knowledge_entry_id" IS DISTINCT FROM OLD."target_knowledge_entry_id"
        OR NEW."observed_visitor_claim" IS DISTINCT FROM OLD."observed_visitor_claim"
        OR NEW."ai_inference" IS DISTINCT FROM OLD."ai_inference"
        OR NEW."proposed_change" IS DISTINCT FROM OLD."proposed_change"
        OR NEW."reason" IS DISTINCT FROM OLD."reason"
        OR NEW."confidence" IS DISTINCT FROM OLD."confidence"
        OR NEW."evidence_message_ids" IS DISTINCT FROM OLD."evidence_message_ids"
        OR NEW."created_by_type" IS DISTINCT FROM OLD."created_by_type"
        OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
      )
    )
  THEN
    RAISE EXCEPTION 'support-linked knowledge proposal source evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_proposals_support_source_immutable"
BEFORE UPDATE ON "knowledge_change_proposals"
FOR EACH ROW EXECUTE FUNCTION prevent_support_knowledge_proposal_source_mutation();
