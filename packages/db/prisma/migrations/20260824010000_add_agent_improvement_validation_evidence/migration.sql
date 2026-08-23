BEGIN;

CREATE TYPE "AgentImprovementImplementationKind" AS ENUM (
  'CODE_COMMIT',
  'CONFIG_VERSION',
  'PROMPT_VERSION',
  'SKILL_VERSION',
  'WORKFLOW_VERSION',
  'TOOL_VERSION',
  'MODEL_POLICY_VERSION'
);

CREATE TYPE "AgentImprovementChangeDimension" AS ENUM ('CONTENT', 'MODEL', 'CONFIG');

CREATE UNIQUE INDEX "eval_runs_id_tenant_venue_key"
  ON "eval_runs"("id", "tenant_id", "venue_id");

CREATE TABLE "agent_improvement_validation_evidence" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "approval_decision_id" TEXT NOT NULL,
  "baseline_eval_run_id" UUID NOT NULL,
  "candidate_eval_run_id" UUID NOT NULL,
  "implementation_kind" "AgentImprovementImplementationKind" NOT NULL,
  "implementation_ref" VARCHAR(500) NOT NULL,
  "implementation_version" VARCHAR(191),
  "implementation_hash" CHAR(64) NOT NULL,
  "change_dimensions" "AgentImprovementChangeDimension"[] NOT NULL,
  "comparison_snapshot" JSONB NOT NULL,
  "comparison_hash" CHAR(64) NOT NULL,
  "recorded_by_type" "ActorType" NOT NULL,
  "recorded_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_improvement_validation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_improvement_validations_distinct_runs_check"
    CHECK ("baseline_eval_run_id" <> "candidate_eval_run_id"),
  CONSTRAINT "agent_improvement_validations_hashes_check"
    CHECK (
      "implementation_hash" ~ '^[0-9a-f]{64}$'
      AND "comparison_hash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "agent_improvement_validations_text_check"
    CHECK (BTRIM("implementation_ref") <> ''),
  CONSTRAINT "agent_improvement_validations_dimensions_check"
    CHECK (CARDINALITY("change_dimensions") > 0)
);

CREATE UNIQUE INDEX "agent_improvement_validations_id_tenant_key"
  ON "agent_improvement_validation_evidence"("id", "tenant_id");
CREATE UNIQUE INDEX "agent_improvement_validations_tenant_operation_key"
  ON "agent_improvement_validation_evidence"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "agent_improvement_validations_exact_evidence_key"
  ON "agent_improvement_validation_evidence"(
    "proposal_id", "baseline_eval_run_id", "candidate_eval_run_id", "implementation_hash"
  );
CREATE INDEX "agent_improvement_validations_scope_created_idx"
  ON "agent_improvement_validation_evidence"("tenant_id", "venue_id", "created_at", "id");
CREATE INDEX "agent_improvement_validations_proposal_created_idx"
  ON "agent_improvement_validation_evidence"("tenant_id", "proposal_id", "created_at");

ALTER TABLE "agent_improvement_validation_evidence"
  ADD CONSTRAINT "agent_improvement_validations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_validations_venue_scope_fkey"
    FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_validations_proposal_scope_fkey"
    FOREIGN KEY ("proposal_id", "tenant_id") REFERENCES "agent_improvement_proposals"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_validations_decision_scope_fkey"
    FOREIGN KEY ("approval_decision_id", "tenant_id") REFERENCES "approval_decisions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_validations_baseline_scope_fkey"
    FOREIGN KEY ("baseline_eval_run_id", "tenant_id", "venue_id") REFERENCES "eval_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_validations_candidate_scope_fkey"
    FOREIGN KEY ("candidate_eval_run_id", "tenant_id", "venue_id") REFERENCES "eval_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "agent_improvement_validations_append_only_guard"
  BEFORE UPDATE OR DELETE ON "agent_improvement_validation_evidence"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_improvement_proposal_evidence();

-- The new capability records evidence only. It cannot apply an implementation,
-- change routing/policy, or expand any identity's authority.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-improvements:propose','agent-improvements:read','agent-improvements:validate','agent-runs:execute','agent-runs:read','ai-usage:read','billing:propose','billing:read','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','jobs:read','knowledge:draft','knowledge:read','locations:propose','meetings:process','meetings:read','outcomes:read','packages:draft','packages:read','questions:ask','questions:read','readiness:read','reports:read','resources:read','support:draft','support:read','updates:draft','updates:read','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
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
