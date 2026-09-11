CREATE TYPE "AgentWorkflowVersionKind" AS ENUM ('SKILL', 'WORKFLOW');
CREATE TYPE "AgentWorkflowVersionStatus" AS ENUM ('REGISTERED_UNACTIVATED');

CREATE TABLE "agent_workflow_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "registry_key" VARCHAR(191) NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" "AgentWorkflowVersionKind" NOT NULL,
  "status" "AgentWorkflowVersionStatus" NOT NULL DEFAULT 'REGISTERED_UNACTIVATED',
  "manifest" JSONB NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "portable_text" TEXT NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "provenance" JSONB NOT NULL,
  "required_tool_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "supersedes_version_id" UUID,
  "created_by_type" "ActorType" NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_workflow_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_workflow_versions_version_check" CHECK ("version" BETWEEN 1 AND 10000),
  CONSTRAINT "agent_workflow_versions_manifest_object_check" CHECK (jsonb_typeof("manifest") = 'object'),
  CONSTRAINT "agent_workflow_versions_provenance_object_check" CHECK (jsonb_typeof("provenance") = 'object')
);

CREATE UNIQUE INDEX "agent_workflow_versions_id_scope_key" ON "agent_workflow_versions"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "agent_workflow_versions_tenant_operation_key" ON "agent_workflow_versions"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "agent_workflow_versions_scope_key_version_key" ON "agent_workflow_versions"("tenant_id", "venue_id", "registry_key", "version");
ALTER TABLE "agent_workflow_versions" ADD CONSTRAINT "agent_workflow_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_versions" ADD CONSTRAINT "agent_workflow_versions_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_workflow_versions" ADD CONSTRAINT "agent_workflow_versions_supersedes_version_scope_fkey" FOREIGN KEY ("supersedes_version_id", "tenant_id", "venue_id") REFERENCES "agent_workflow_versions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_agent_workflow_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent workflow versions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_workflow_versions_immutable_update" BEFORE UPDATE ON "agent_workflow_versions" FOR EACH ROW EXECUTE FUNCTION reject_agent_workflow_version_mutation();
CREATE TRIGGER "agent_workflow_versions_immutable_delete" BEFORE DELETE ON "agent_workflow_versions" FOR EACH ROW EXECUTE FUNCTION reject_agent_workflow_version_mutation();
