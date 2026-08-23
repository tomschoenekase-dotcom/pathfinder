BEGIN;

CREATE TYPE "CustomerAccessRequestStatus" AS ENUM (
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'PROVIDER_STARTED',
  'INVITED',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE "CustomerAccessRequestedRole" AS ENUM ('MEMBER');

CREATE TABLE "customer_access_requests" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "source_support_message_id" TEXT NOT NULL,
  "approval_request_id" TEXT NOT NULL,
  "target_email" VARCHAR(320) NOT NULL,
  "requested_role" "CustomerAccessRequestedRole" NOT NULL DEFAULT 'MEMBER',
  "reason" VARCHAR(2000) NOT NULL,
  "status" "CustomerAccessRequestStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
  "provider_invitation_id" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_access_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_access_requests_email_shape_check" CHECK (
    "target_email" = LOWER(BTRIM("target_email"))
    AND LENGTH("target_email") BETWEEN 3 AND 320
    AND POSITION('@' IN "target_email") > 1
  ),
  CONSTRAINT "customer_access_requests_reason_check" CHECK (BTRIM("reason") <> '')
);

CREATE UNIQUE INDEX "customer_access_requests_provider_invitation_id_key"
  ON "customer_access_requests"("provider_invitation_id");
CREATE UNIQUE INDEX "customer_access_requests_tenant_operation_key"
  ON "customer_access_requests"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "customer_access_requests_approval_scope_key"
  ON "customer_access_requests"("approval_request_id", "tenant_id");
CREATE UNIQUE INDEX "customer_access_requests_id_scope_key"
  ON "customer_access_requests"("id", "tenant_id", "venue_id");
CREATE INDEX "customer_access_requests_scope_status_created_idx"
  ON "customer_access_requests"("tenant_id", "venue_id", "status", "created_at", "id");
CREATE INDEX "customer_access_requests_email_status_created_idx"
  ON "customer_access_requests"("tenant_id", "target_email", "status", "created_at", "id");
CREATE UNIQUE INDEX "customer_access_requests_active_email_key"
  ON "customer_access_requests"("tenant_id", "target_email")
  WHERE "status" IN ('AWAITING_APPROVAL', 'APPROVED', 'PROVIDER_STARTED', 'RECONCILIATION_REQUIRED');

ALTER TABLE "customer_access_requests"
  ADD CONSTRAINT "customer_access_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_access_requests_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_access_requests_identity_scope_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_access_requests_run_scope_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_access_requests_support_request_scope_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_access_requests_source_message_scope_fkey"
  FOREIGN KEY ("source_support_message_id", "tenant_id", "venue_id", "support_request_id") REFERENCES "support_messages"("id", "tenant_id", "venue_id", "support_request_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_access_requests_approval_scope_fkey"
  FOREIGN KEY ("approval_request_id", "tenant_id") REFERENCES "approval_requests"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_customer_access_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_access_requests cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AWAITING_APPROVAL' OR NEW."provider_invitation_id" IS NOT NULL THEN
      RAISE EXCEPTION 'customer access requests must begin provider-dark and awaiting approval';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW."operation_id", NEW."tenant_id", NEW."venue_id", NEW."agent_identity_id",
    NEW."agent_run_id", NEW."support_request_id", NEW."source_support_message_id",
    NEW."approval_request_id", NEW."target_email", NEW."requested_role", NEW."reason",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."operation_id", OLD."tenant_id", OLD."venue_id", OLD."agent_identity_id",
    OLD."agent_run_id", OLD."support_request_id", OLD."source_support_message_id",
    OLD."approval_request_id", OLD."target_email", OLD."requested_role", OLD."reason",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'customer access request evidence is immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PROVIDER_STARTED', 'CANCELLED'))
    OR (OLD."status" = 'PROVIDER_STARTED' AND NEW."status" IN ('INVITED', 'RECONCILIATION_REQUIRED'))
    OR (OLD."status" = 'RECONCILIATION_REQUIRED' AND NEW."status" IN ('PROVIDER_STARTED', 'INVITED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'invalid customer access request lifecycle transition';
  END IF;
  IF NEW."status" = 'INVITED' AND NEW."provider_invitation_id" IS NULL THEN
    RAISE EXCEPTION 'invited customer access request requires provider evidence';
  END IF;
  IF NEW."status" <> 'INVITED' AND NEW."provider_invitation_id" IS NOT NULL THEN
    RAISE EXCEPTION 'provider invitation evidence is only valid for invited requests';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "customer_access_requests_lifecycle_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "customer_access_requests"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_customer_access_request();

-- Admit only the provider-dark invitation-preparation capability. Credential
-- issuance and activation remain separately evidenced and fail closed.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-runs:execute','agent-runs:read','ai-usage:read','billing:propose','billing:read','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','jobs:read','knowledge:draft','knowledge:read','meetings:process','meetings:read','outcomes:read','packages:draft','packages:read','questions:ask','questions:read','readiness:read','reports:read','resources:read','support:draft','support:read','updates:draft','updates:read','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported MCP credential capability';
  END IF;
  IF NEW."kind" = 'PARTNER_READ_API' AND (NEW."capabilities" <@ ARRAY['approved-content:read','clients:read','configuration:read','readiness:read','updates:read','venues:read']::TEXT[]) IS NOT TRUE THEN
    RAISE EXCEPTION 'unsupported partner credential capability';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM "external_credential_operation_receipts" receipt WHERE receipt."credential_id" = NEW."id" AND receipt."operation_kind" IN ('ISSUE','ROTATE')) THEN
    RAISE EXCEPTION 'new external credential requires operation evidence';
  END IF;
  IF NEW."enabled" AND NOT EXISTS (
    SELECT 1 FROM "external_credential_activations" activation
      WHERE activation."credential_id" = NEW."id"
        AND activation."tenant_id" = NEW."tenant_id"
        AND activation."client_id" = NEW."client_id"
        AND activation."scope_key" = NEW."scope_key"
        AND activation."activated_at" = NEW."updated_at"
  ) THEN
    RAISE EXCEPTION 'enabled external credential requires exact activation evidence';
  END IF;
  IF NEW."revoked_at" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "external_credential_revocations" revocation WHERE revocation."credential_id" = NEW."id" AND revocation."revoked_at" = NEW."revoked_at") THEN
    RAISE EXCEPTION 'external credential revocation requires exact timestamp evidence';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
