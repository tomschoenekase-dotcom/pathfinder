ALTER TABLE "intake_runs"
  ADD COLUMN "requested_by_type" "ActorType" NOT NULL DEFAULT 'HUMAN',
  ADD COLUMN "agent_identity_id" VARCHAR(191),
  ADD COLUMN "agent_run_id" VARCHAR(191),
  ADD COLUMN "worker_id" VARCHAR(191),
  ADD COLUMN "credential_id" VARCHAR(191),
  ADD COLUMN "approval_grant_id" VARCHAR(191),
  ADD COLUMN "capability" VARCHAR(191),
  ADD COLUMN "model_provider" VARCHAR(100),
  ADD COLUMN "model_name" VARCHAR(191);

ALTER TABLE "intake_runs"
  ADD CONSTRAINT "intake_runs_machine_lineage_check"
  CHECK (
    (
      "requested_by_type" = 'HUMAN'
      AND "agent_identity_id" IS NULL
      AND "agent_run_id" IS NULL
      AND "worker_id" IS NULL
      AND "credential_id" IS NULL
      AND "approval_grant_id" IS NULL
      AND "capability" IS NULL
      AND "model_provider" IS NULL
      AND "model_name" IS NULL
    )
    OR
    (
      "requested_by_type" = 'AGENT'
      AND "requested_by" = "agent_identity_id"
      AND "agent_identity_id" IS NOT NULL
      AND "agent_run_id" IS NOT NULL
      AND "worker_id" IS NOT NULL
      AND "credential_id" IS NOT NULL
      AND "approval_grant_id" IS NOT NULL
      AND "capability" = 'intake:draft'
      AND (("model_provider" IS NULL) = ("model_name" IS NULL))
    )
  );

CREATE INDEX "intake_runs_agent_run_created_idx"
  ON "intake_runs" ("tenant_id", "agent_run_id", "created_at");

-- Admit the new proposal-only capability through the same fail-closed
-- credential evidence trigger. This does not activate or issue credentials.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-improvements:propose','agent-improvements:read','agent-improvements:validate','agent-runs:execute','agent-runs:read','ai-usage:read','billing:propose','billing:read','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','intake:draft','jobs:read','knowledge:draft','knowledge:read','locations:propose','meetings:process','meetings:read','outcomes:read','packages:draft','packages:read','questions:ask','questions:read','readiness:read','reports:read','resources:read','support:draft','support:read','updates:draft','updates:read','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
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
