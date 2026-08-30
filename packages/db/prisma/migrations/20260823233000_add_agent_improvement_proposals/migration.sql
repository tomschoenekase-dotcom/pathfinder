BEGIN;

CREATE TYPE "AgentImprovementTargetKind" AS ENUM (
  'INSTRUCTIONS',
  'ROUTING',
  'RETRIEVAL',
  'SKILL',
  'WORKFLOW',
  'TOOLING',
  'MODEL_SELECTION'
);

CREATE TABLE "agent_improvement_proposals" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "approval_request_id" TEXT NOT NULL,
  "proposal_key" VARCHAR(191) NOT NULL,
  "revision" INTEGER NOT NULL,
  "supersedes_proposal_id" TEXT,
  "task_class" VARCHAR(100) NOT NULL,
  "target_kind" "AgentImprovementTargetKind" NOT NULL,
  "title" VARCHAR(191) NOT NULL,
  "hypothesis" VARCHAR(2000) NOT NULL,
  "proposed_change" VARCHAR(10000) NOT NULL,
  "validation_plan" VARCHAR(5000) NOT NULL,
  "baseline_snapshot" JSONB NOT NULL,
  "created_by_type" "ActorType" NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_improvement_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_improvement_proposals_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "agent_improvement_proposals_revision_lineage_check" CHECK (
    ("revision" = 1 AND "supersedes_proposal_id" IS NULL)
    OR ("revision" > 1 AND "supersedes_proposal_id" IS NOT NULL)
  ),
  CONSTRAINT "agent_improvement_proposals_text_check" CHECK (
    BTRIM("proposal_key") <> ''
    AND BTRIM("task_class") <> ''
    AND BTRIM("title") <> ''
    AND BTRIM("hypothesis") <> ''
    AND BTRIM("proposed_change") <> ''
    AND BTRIM("validation_plan") <> ''
  )
);

CREATE TABLE "agent_improvement_proposal_evidence" (
  "tenant_id" TEXT NOT NULL,
  "proposal_id" TEXT NOT NULL,
  "outcome_observation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_improvement_proposal_evidence_pkey"
    PRIMARY KEY ("proposal_id", "outcome_observation_id")
);

CREATE UNIQUE INDEX "agent_improvement_proposals_approval_request_id_key"
  ON "agent_improvement_proposals"("approval_request_id");
CREATE UNIQUE INDEX "agent_improvement_proposals_approval_scope_key"
  ON "agent_improvement_proposals"("approval_request_id", "tenant_id");
CREATE UNIQUE INDEX "agent_improvement_proposals_id_tenant_id_key"
  ON "agent_improvement_proposals"("id", "tenant_id");
CREATE UNIQUE INDEX "agent_improvement_proposals_tenant_operation_key"
  ON "agent_improvement_proposals"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "agent_improvement_proposals_key_revision_key"
  ON "agent_improvement_proposals"("tenant_id", "proposal_key", "revision");
CREATE INDEX "agent_improvement_proposals_scope_created_idx"
  ON "agent_improvement_proposals"("tenant_id", "venue_id", "created_at", "id");
CREATE INDEX "agent_improvement_proposals_target_created_idx"
  ON "agent_improvement_proposals"("tenant_id", "agent_identity_id", "task_class", "created_at");
CREATE INDEX "agent_improvement_evidence_outcome_idx"
  ON "agent_improvement_proposal_evidence"("tenant_id", "outcome_observation_id");

ALTER TABLE "agent_improvement_proposals"
  ADD CONSTRAINT "agent_improvement_proposals_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_proposals_venue_scope_fkey"
    FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_proposals_identity_scope_fkey"
    FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_proposals_approval_scope_fkey"
    FOREIGN KEY ("approval_request_id", "tenant_id") REFERENCES "approval_requests"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_proposals_supersedes_scope_fkey"
    FOREIGN KEY ("supersedes_proposal_id", "tenant_id") REFERENCES "agent_improvement_proposals"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_improvement_proposal_evidence"
  ADD CONSTRAINT "agent_improvement_evidence_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_evidence_proposal_scope_fkey"
    FOREIGN KEY ("proposal_id", "tenant_id") REFERENCES "agent_improvement_proposals"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_improvement_evidence_outcome_scope_fkey"
    FOREIGN KEY ("outcome_observation_id", "tenant_id") REFERENCES "agent_outcome_observations"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_agent_improvement_proposal_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'agent improvement proposal evidence is append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_improvement_proposals_append_only_guard"
  BEFORE UPDATE OR DELETE ON "agent_improvement_proposals"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_improvement_proposal_evidence();

CREATE TRIGGER "agent_improvement_evidence_append_only_guard"
  BEFORE UPDATE OR DELETE ON "agent_improvement_proposal_evidence"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_improvement_proposal_evidence();

-- Admit only the read and review-proposal capabilities. Neither capability can
-- apply an improvement or expand an agent's operating authority.
CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capabilities" <> ARRAY(SELECT DISTINCT value FROM unnest(NEW."capabilities") value ORDER BY value) THEN
    RAISE EXCEPTION 'external credential capabilities must be sorted and unique';
  END IF;
  IF NEW."kind" = 'MCP' AND (NEW."capabilities" <@ ARRAY['accounts:read','agent-improvements:propose','agent-improvements:read','agent-runs:execute','agent-runs:read','ai-usage:read','billing:propose','billing:read','clients:read','configuration:read','content:read','conversations:read','conversations:review','customer-access:prepare','delegations:create','deployments:read','evaluations:read','evaluations:request','events:read','feature-flags:read','history:read','integrations:read','jobs:read','knowledge:draft','knowledge:read','locations:propose','meetings:process','meetings:read','outcomes:read','packages:draft','packages:read','questions:ask','questions:read','readiness:read','reports:read','resources:read','support:draft','support:read','updates:draft','updates:read','venues:read','workers:read']::TEXT[]) IS NOT TRUE THEN
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
