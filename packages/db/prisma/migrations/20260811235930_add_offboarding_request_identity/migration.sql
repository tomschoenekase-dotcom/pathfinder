BEGIN;

ALTER TABLE "offboarding_plans"
  ADD COLUMN "request_id" UUID,
  ADD COLUMN "request_hash" CHAR(64);

-- Packet 2's offboarding foundation remains unapplied. Refuse to invent retry
-- identity for any unexpected pre-existing plan; an owner must explicitly
-- reconcile such evidence before this migration can continue.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "offboarding_plans") THEN
    RAISE EXCEPTION
      'Existing offboarding plans require an owner-approved request-identity backfill';
  END IF;
END;
$$;

ALTER TABLE "offboarding_plans"
  ALTER COLUMN "request_id" SET NOT NULL,
  ALTER COLUMN "request_hash" SET NOT NULL,
  ADD CONSTRAINT "offboarding_plans_request_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "offboarding_plans_tenant_request_key"
  ON "offboarding_plans"("tenant_id", "request_id");

CREATE FUNCTION pathfinder_guard_offboarding_request_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."request_id" IS DISTINCT FROM OLD."request_id"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash" THEN
    RAISE EXCEPTION 'offboarding plan request identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offboarding_plans_request_identity_immutable
BEFORE UPDATE ON "offboarding_plans"
FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_offboarding_request_identity();

COMMIT;
