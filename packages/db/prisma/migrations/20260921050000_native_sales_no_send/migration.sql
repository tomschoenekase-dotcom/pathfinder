-- Reuse the existing versioned draft owner. No parallel sales/draft/thread tables.
ALTER TABLE prospect_outreach_drafts
  ALTER COLUMN campaign_id DROP NOT NULL,
  ALTER COLUMN member_id DROP NOT NULL,
  ALTER COLUMN to_email DROP NOT NULL,
  ADD COLUMN preparation_key CHAR(64);

ALTER TABLE prospect_outreach_drafts ADD CONSTRAINT prospect_draft_owner_mode CHECK (
  (preparation_key IS NULL AND campaign_id IS NOT NULL AND member_id IS NOT NULL AND to_email IS NOT NULL)
  OR
  (preparation_key IS NOT NULL AND preparation_key ~ '^[a-f0-9]{64}$' AND campaign_id IS NULL AND member_id IS NULL
    AND venue_id IS NOT NULL AND status = 'NEEDS_REVIEW'
    AND approved_by IS NULL AND approved_at IS NULL
    AND (grounding_snapshot->>'SEND_AUTHORIZED' = 'false') IS TRUE
    AND (grounding_snapshot->>'schema' = 'torchiko.native-sales-draft/1') IS TRUE)
);
CREATE UNIQUE INDEX prospect_outreach_drafts_preparation_revision_key
  ON prospect_outreach_drafts(preparation_key, version);
CREATE INDEX prospect_outreach_drafts_preparation_venue_idx
  ON prospect_outreach_drafts(venue_id, preparation_key, created_at);

CREATE FUNCTION protect_no_send_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.preparation_key IS NOT NULL THEN
    RAISE EXCEPTION 'NO_SEND_REVISION_IMMUTABLE: append a revision or an exact review activity';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.preparation_key IS NOT NULL THEN
    RAISE EXCEPTION 'NO_SEND_MODE_IMMUTABLE: cannot relabel an existing campaign draft';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER prospect_no_send_draft_immutable
  BEFORE UPDATE OR DELETE ON prospect_outreach_drafts
  FOR EACH ROW EXECUTE FUNCTION protect_no_send_draft_revision();

CREATE FUNCTION reject_no_send_frozen_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM prospect_outreach_drafts WHERE id = NEW.draft_id AND preparation_key IS NOT NULL) THEN
    RAISE EXCEPTION 'NO_SEND_NOT_A_RECIPIENT: preparation cannot enter frozen recipients or delivery';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prospect_no_send_frozen_recipient_guard
  BEFORE INSERT OR UPDATE OF draft_id ON prospect_send_items
  FOR EACH ROW EXECUTE FUNCTION reject_no_send_frozen_recipient();

-- Prepared component snapshots are append-only, not new externally verified facts.
CREATE FUNCTION protect_sales_component_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_type = 'CRM_SALES_PREPARATION_V1' THEN
    RAISE EXCEPTION 'NO_SEND_PREPARATION_IMMUTABLE: append a new source-bound snapshot';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER prospect_sales_component_snapshot_immutable
  BEFORE UPDATE OR DELETE ON prospect_source_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_sales_component_snapshot();

CREATE FUNCTION protect_sales_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.evidence->>'schema' = 'torchiko.native-sales-review/1' THEN
    RAISE EXCEPTION 'NO_SEND_REVIEW_IMMUTABLE: review another exact revision instead';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER prospect_sales_review_immutable
  BEFORE UPDATE OR DELETE ON prospect_activities
  FOR EACH ROW EXECUTE FUNCTION protect_sales_review_identity();
