-- Durable, default-dark recurring AgentRun definitions. Scheduler replicas
-- compete on the same routine row; the dispatch uniqueness constraint is the
-- final idempotency boundary.
CREATE TABLE "agent_routines" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "routine_key" VARCHAR(191) NOT NULL,
  "agent_identity_id" TEXT NOT NULL,
  "requested_operation" VARCHAR(191) NOT NULL,
  "prompt" VARCHAR(10000) NOT NULL,
  "interval_seconds" INTEGER NOT NULL,
  "max_attempts" INTEGER NOT NULL DEFAULT 1,
  "max_runs_per_day" INTEGER NOT NULL DEFAULT 24,
  "per_run_budget_e8_usd" BIGINT,
  "daily_budget_e8_usd" BIGINT,
  "required_worker_roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "required_worker_capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "next_run_at" TIMESTAMP(3),
  "last_run_at" TIMESTAMP(3),
  "last_skip_reason" VARCHAR(191),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_routines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_routines_scope_key" ON "agent_routines"("tenant_id", "venue_id", "routine_key");
CREATE UNIQUE INDEX "agent_routines_id_scope_key" ON "agent_routines"("id", "tenant_id", "venue_id");
CREATE INDEX "agent_routines_due_idx" ON "agent_routines"("enabled", "next_run_at");
CREATE INDEX "agent_routines_scope_created_idx" ON "agent_routines"("tenant_id", "venue_id", "created_at");

ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_agent_identity_id_tenant_id_fkey"
  FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_interval_seconds_check"
  CHECK ("interval_seconds" BETWEEN 60 AND 604800);
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_max_attempts_check"
  CHECK ("max_attempts" = 1);
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_max_runs_per_day_check"
  CHECK ("max_runs_per_day" BETWEEN 1 AND 1440);
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_per_run_budget_nonnegative_check"
  CHECK ("per_run_budget_e8_usd" IS NULL OR "per_run_budget_e8_usd" >= 0);
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_daily_budget_nonnegative_check"
  CHECK ("daily_budget_e8_usd" IS NULL OR "daily_budget_e8_usd" >= 0);
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_daily_budget_requires_per_run_check"
  CHECK ("daily_budget_e8_usd" IS NULL OR "per_run_budget_e8_usd" IS NOT NULL);
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_budget_order_check"
  CHECK (
    "per_run_budget_e8_usd" IS NULL OR "daily_budget_e8_usd" IS NULL
    OR "per_run_budget_e8_usd" <= "daily_budget_e8_usd"
  );

CREATE TABLE "agent_routine_dispatches" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "routine_id" TEXT NOT NULL,
  "scheduled_for" TIMESTAMP(3) NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_routine_dispatches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_routine_dispatches_agent_run_id_key" ON "agent_routine_dispatches"("agent_run_id");
CREATE UNIQUE INDEX "agent_routine_dispatches_routine_due_key" ON "agent_routine_dispatches"("routine_id", "scheduled_for");
CREATE UNIQUE INDEX "agent_routine_dispatches_run_scope_key" ON "agent_routine_dispatches"("agent_run_id", "tenant_id", "venue_id");
CREATE INDEX "agent_routine_dispatches_scope_due_idx" ON "agent_routine_dispatches"("tenant_id", "venue_id", "scheduled_for");

ALTER TABLE "agent_routine_dispatches" ADD CONSTRAINT "agent_routine_dispatches_routine_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("routine_id", "tenant_id", "venue_id") REFERENCES "agent_routines"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routine_dispatches" ADD CONSTRAINT "agent_routine_dispatches_agent_run_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routine_dispatches" ADD CONSTRAINT "agent_routine_dispatches_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routine_dispatches" ADD CONSTRAINT "agent_routine_dispatches_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
