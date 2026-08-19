CREATE TYPE "AgentBridgeProvider" AS ENUM (
  'HERMES', 'CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION', 'OPENAI_COMPATIBLE'
);
CREATE TYPE "AgentBridgeSessionStatus" AS ENUM ('ONLINE', 'OFFLINE', 'REVOKED');

CREATE TABLE "agent_bridge_sessions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "scope_key" VARCHAR(191) NOT NULL,
  "credential_id" TEXT NOT NULL,
  "provider" "AgentBridgeProvider" NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "runner_version" VARCHAR(100) NOT NULL,
  "supported_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" "AgentBridgeSessionStatus" NOT NULL DEFAULT 'ONLINE',
  "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_bridge_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_bridge_sessions_id_tenant_id_key"
  ON "agent_bridge_sessions"("id", "tenant_id");
CREATE INDEX "agent_bridge_sessions_scope_status_idx"
  ON "agent_bridge_sessions"("tenant_id", "venue_id", "provider", "status", "last_heartbeat_at");

ALTER TABLE "agent_bridge_sessions"
  ADD CONSTRAINT "agent_bridge_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_bridge_sessions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id")
  REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_bridge_sessions_credential_id_tenant_id_client_id_scope_key_fkey"
  FOREIGN KEY ("credential_id", "tenant_id", "client_id", "scope_key")
  REFERENCES "external_access_credentials"("id", "tenant_id", "client_id", "scope_key")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_runs" ADD COLUMN "execution_bridge_session_id" TEXT;
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_execution_bridge_session_id_tenant_id_fkey"
  FOREIGN KEY ("execution_bridge_session_id", "tenant_id")
  REFERENCES "agent_bridge_sessions"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
