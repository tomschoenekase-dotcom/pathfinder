-- Preserve all existing human audit rows while adding explicit machine/system/integration lineage.
ALTER TYPE "ActorType" ADD VALUE IF NOT EXISTS 'INTEGRATION';

ALTER TABLE "audit_logs"
  ADD COLUMN "actor_type" "ActorType" NOT NULL DEFAULT 'HUMAN',
  ADD COLUMN "agent_identity_id" TEXT,
  ADD COLUMN "agent_run_id" TEXT,
  ADD COLUMN "worker_id" TEXT,
  ADD COLUMN "system_job_id" TEXT,
  ADD COLUMN "integration_id" TEXT,
  ADD COLUMN "credential_id" TEXT,
  ADD COLUMN "approval_grant_id" TEXT,
  ADD COLUMN "capability" TEXT,
  ADD COLUMN "model_provider" TEXT,
  ADD COLUMN "model_name" TEXT,
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "structured_reason" JSONB,
  ADD COLUMN "source_references" JSONB;

CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx"
  ON "audit_logs"("actor_type", "actor_id", "created_at");
CREATE INDEX "audit_logs_tenant_id_agent_run_id_created_at_idx"
  ON "audit_logs"("tenant_id", "agent_run_id", "created_at");
CREATE INDEX "audit_logs_tenant_id_worker_id_created_at_idx"
  ON "audit_logs"("tenant_id", "worker_id", "created_at");
CREATE INDEX "audit_logs_tenant_id_approval_grant_id_created_at_idx"
  ON "audit_logs"("tenant_id", "approval_grant_id", "created_at");
