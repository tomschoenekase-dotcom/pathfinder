-- Preserve founder-approved multi-venue negotiated-price components in Torchiko's
-- own commercial history. This migration creates no price, provider object,
-- subscription, invoice, payment, or customer communication.

ALTER TABLE "commercial_agreements"
  ADD COLUMN "venue_price_breakdown_complete" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "commercial_agreement_venues"
  ADD COLUMN "agreed_amount_minor" BIGINT;

ALTER TABLE "commercial_agreement_venues"
  ADD CONSTRAINT "commercial_agreement_venues_amount_check"
  CHECK ("agreed_amount_minor" IS NULL OR "agreed_amount_minor" > 0);

CREATE OR REPLACE FUNCTION validate_commercial_agreement_venue_pricing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tenant_id TEXT;
  target_agreement_id TEXT;
  agreement_total BIGINT;
  breakdown_complete BOOLEAN;
  expected_venue_count INTEGER;
  actual_venue_count BIGINT;
  priced_venue_count BIGINT;
  venue_total NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'commercial_agreements' THEN
    target_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
    target_agreement_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
    target_agreement_id := COALESCE(NEW.commercial_agreement_id, OLD.commercial_agreement_id);
  END IF;

  SELECT agreed_amount_minor, venue_price_breakdown_complete, covered_venue_count
    INTO agreement_total, breakdown_complete, expected_venue_count
  FROM commercial_agreements
  WHERE tenant_id = target_tenant_id AND id = target_agreement_id;

  -- A deleted agreement has no remaining invariant to verify.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COUNT(agreed_amount_minor), COALESCE(SUM(agreed_amount_minor), 0)
    INTO actual_venue_count, priced_venue_count, venue_total
  FROM commercial_agreement_venues
  WHERE tenant_id = target_tenant_id
    AND commercial_agreement_id = target_agreement_id;

  IF breakdown_complete THEN
    IF agreement_total IS NULL THEN
      RAISE EXCEPTION 'complete venue price breakdown requires an agreement total'
        USING ERRCODE = '23514';
    END IF;
    IF actual_venue_count <> expected_venue_count OR priced_venue_count <> actual_venue_count THEN
      RAISE EXCEPTION 'complete venue price breakdown must price every covered venue'
        USING ERRCODE = '23514';
    END IF;
    IF venue_total <> agreement_total THEN
      RAISE EXCEPTION 'venue price breakdown must equal the agreement total'
        USING ERRCODE = '23514';
    END IF;
  ELSIF priced_venue_count <> 0 THEN
    RAISE EXCEPTION 'venue price components require an explicitly complete breakdown'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "commercial_agreements_venue_pricing_guard"
AFTER INSERT OR UPDATE OF "agreed_amount_minor", "venue_price_breakdown_complete", "covered_venue_count"
ON "commercial_agreements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_commercial_agreement_venue_pricing();

CREATE CONSTRAINT TRIGGER "commercial_agreement_venues_pricing_guard"
AFTER INSERT OR UPDATE OF "agreed_amount_minor", "tenant_id", "commercial_agreement_id" OR DELETE
ON "commercial_agreement_venues"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_commercial_agreement_venue_pricing();
