CREATE TYPE "AgentWorkerRuntime" AS ENUM ('HERMES', 'CODEX', 'CLAUDE', 'OPENAI_COMPATIBLE', 'CUSTOM');

CREATE TYPE "AgentWorkerStatus" AS ENUM ('ONLINE', 'DRAINING', 'OFFLINE', 'REVOKED');

CREATE TABLE "agent_workers" (
  "id" TEXT NOT NULL,
  "worker_key" VARCHAR(191) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL,
  "credential_scope_key" VARCHAR(191) NOT NULL,
  "owner_admin_id" VARCHAR(191) NOT NULL,
  "runtime_type" "AgentWorkerRuntime" NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "protocol_version" VARCHAR(100) NOT NULL,
  "software_version" VARCHAR(100) NOT NULL,
  "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "agent_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "model_provider" VARCHAR(100),
  "model_name" VARCHAR(191),
  "safe_health" JSONB NOT NULL DEFAULT '{}',
  "status" "AgentWorkerStatus" NOT NULL DEFAULT 'ONLINE',
  "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "offline_at" TIMESTAMP(3),
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_workers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_workers_worker_key_key" ON "agent_workers"("worker_key");
CREATE UNIQUE INDEX "agent_workers_id_tenant_id_key" ON "agent_workers"("id", "tenant_id");
CREATE INDEX "agent_workers_tenant_status_idx" ON "agent_workers"("tenant_id", "status", "last_heartbeat_at");
CREATE INDEX "agent_workers_credential_status_idx" ON "agent_workers"("credential_id", "status");

ALTER TABLE "agent_workers" ADD CONSTRAINT "agent_workers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workers" ADD CONSTRAINT "agent_workers_credential_id_tenant_id_client_id_credential_scope_key_fkey"
  FOREIGN KEY ("credential_id", "tenant_id", "client_id", "credential_scope_key")
  REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_runs" ADD COLUMN "execution_worker_id" TEXT;
CREATE INDEX "agent_runs_worker_status_idx" ON "agent_runs"("execution_worker_id", "status", "updated_at");
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_execution_worker_id_fkey"
  FOREIGN KEY ("execution_worker_id") REFERENCES "agent_workers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
