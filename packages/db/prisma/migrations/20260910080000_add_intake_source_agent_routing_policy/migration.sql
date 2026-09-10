CREATE TABLE "intake_source_agent_routing_policies" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intake_source_agent_routing_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_source_agent_routing_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "intake_source_agent_routing_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "intake_source_agent_routing_venue_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "intake_source_agent_routing_identity_fkey" FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "intake_source_agent_routing_venue_key" ON "intake_source_agent_routing_policies"("tenant_id", "venue_id");
CREATE UNIQUE INDEX "intake_source_agent_routing_scope_key" ON "intake_source_agent_routing_policies"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_source_agent_routing_identity_idx" ON "intake_source_agent_routing_policies"("agent_identity_id", "tenant_id");
