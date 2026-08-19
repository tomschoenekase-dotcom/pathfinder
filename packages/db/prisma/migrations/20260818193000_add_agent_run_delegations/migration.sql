ALTER TABLE "agent_runs"
  ADD COLUMN "parent_agent_run_id" TEXT,
  ADD COLUMN "delegation_reason" VARCHAR(1000);

CREATE INDEX "agent_runs_parent_created_idx"
  ON "agent_runs"("tenant_id", "parent_agent_run_id", "created_at");

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_parent_agent_run_id_tenant_id_fkey"
  FOREIGN KEY ("parent_agent_run_id", "tenant_id")
  REFERENCES "agent_runs"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
