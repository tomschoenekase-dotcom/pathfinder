CREATE TYPE "AgentMessageRole" AS ENUM ('OPERATOR', 'AGENT', 'SYSTEM');
CREATE TYPE "AgentMessageType" AS ENUM ('PROMPT', 'RESULT', 'ANSWER', 'STATUS');

CREATE TABLE "agent_messages" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "role" "AgentMessageRole" NOT NULL,
  "message_type" "AgentMessageType" NOT NULL,
  "content" VARCHAR(20000) NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_messages_id_tenant_id_key" ON "agent_messages"("id", "tenant_id");
CREATE INDEX "agent_messages_run_created_idx"
  ON "agent_messages"("tenant_id", "venue_id", "agent_run_id", "created_at", "id");

ALTER TABLE "agent_messages"
  ADD CONSTRAINT "agent_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_messages_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id")
  REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_messages_agent_run_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id")
  REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_messages_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id")
  REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
