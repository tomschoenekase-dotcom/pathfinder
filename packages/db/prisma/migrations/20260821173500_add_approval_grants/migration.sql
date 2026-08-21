CREATE TYPE "ApprovalGrantMode" AS ENUM ('ONE_SHOT', 'BOUNDED', 'TEMPORARY', 'POLICY_BACKED');

CREATE TABLE "approval_grants" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "approval_decision_id" TEXT,
  "policy_key" VARCHAR(191),
  "agent_identity_id" TEXT NOT NULL,
  "action_name" VARCHAR(191) NOT NULL,
  "capability" VARCHAR(191) NOT NULL,
  "mode" "ApprovalGrantMode" NOT NULL,
  "scope" JSONB NOT NULL,
  "parameter_hash" CHAR(64),
  "constraints" JSONB NOT NULL DEFAULT '{}',
  "max_uses" INTEGER,
  "use_count" INTEGER NOT NULL DEFAULT 0,
  "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoked_by_type" "ActorType",
  "revoked_by_id" VARCHAR(191),
  "revoke_reason" VARCHAR(1000),
  "created_by_type" "ActorType" NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "approval_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_grants_source_check" CHECK (
    (("approval_decision_id" IS NOT NULL)::integer + ("policy_key" IS NOT NULL)::integer) = 1
  ),
  CONSTRAINT "approval_grants_use_count_check" CHECK (
    "use_count" >= 0 AND ("max_uses" IS NULL OR ("max_uses" > 0 AND "use_count" <= "max_uses"))
  ),
  CONSTRAINT "approval_grants_window_check" CHECK (
    "expires_at" IS NULL OR "expires_at" > "not_before"
  ),
  CONSTRAINT "approval_grants_one_shot_check" CHECK (
    "mode" <> 'ONE_SHOT' OR ("max_uses" = 1 AND "parameter_hash" IS NOT NULL)
  )
);

CREATE TABLE "approval_grant_consumptions" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "approval_grant_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "worker_id" VARCHAR(191) NOT NULL,
  "credential_id" VARCHAR(191) NOT NULL,
  "action_name" VARCHAR(191) NOT NULL,
  "capability" VARCHAR(191) NOT NULL,
  "parameter_hash" CHAR(64) NOT NULL,
  "result_reference" VARCHAR(500),
  "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "approval_grant_consumptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "approval_grants_id_tenant_id_key" ON "approval_grants"("id", "tenant_id");
CREATE UNIQUE INDEX "approval_grants_decision_tenant_key"
  ON "approval_grants"("approval_decision_id", "tenant_id");
CREATE INDEX "approval_grants_scope_action_active_idx"
  ON "approval_grants"("tenant_id", "venue_id", "action_name", "revoked_at", "expires_at");
CREATE INDEX "approval_grants_agent_created_idx"
  ON "approval_grants"("tenant_id", "agent_identity_id", "created_at");

CREATE UNIQUE INDEX "approval_grant_consumptions_tenant_operation_key"
  ON "approval_grant_consumptions"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "approval_grant_consumptions_grant_operation_key"
  ON "approval_grant_consumptions"("approval_grant_id", "operation_id");
CREATE INDEX "approval_grant_consumptions_grant_time_idx"
  ON "approval_grant_consumptions"("tenant_id", "approval_grant_id", "consumed_at");
CREATE INDEX "approval_grant_consumptions_run_time_idx"
  ON "approval_grant_consumptions"("tenant_id", "agent_run_id", "consumed_at");

ALTER TABLE "approval_grants"
  ADD CONSTRAINT "approval_grants_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grants_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grants_approval_decision_id_tenant_id_fkey"
  FOREIGN KEY ("approval_decision_id", "tenant_id") REFERENCES "approval_decisions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grants_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "approval_grant_consumptions"
  ADD CONSTRAINT "approval_grant_consumptions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grant_consumptions_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grant_consumptions_grant_id_tenant_id_fkey"
  FOREIGN KEY ("approval_grant_id", "tenant_id") REFERENCES "approval_grants"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grant_consumptions_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "approval_grant_consumptions_agent_run_id_tenant_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id") REFERENCES "agent_runs"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
