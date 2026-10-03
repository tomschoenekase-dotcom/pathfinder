BEGIN;

-- Routine reminder stop rules and dollar budgets (acceptance row A23). Additive and forward-only.
-- Existing routines keep working: stop_rules defaults to '{}' and every budget column stays NULL
-- (no budget). The legacy *_e8_usd columns remain inert and untouched.

-- CreateEnum
CREATE TYPE "AgentRoutineBudgetPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH');

-- AlterTable
ALTER TABLE "agent_routines"
  ADD COLUMN "stop_rules" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "stopped_at" TIMESTAMP(3),
  ADD COLUMN "stop_reason" VARCHAR(64),
  ADD COLUMN "budget_cents" INTEGER,
  ADD COLUMN "budget_currency" CHAR(3),
  ADD COLUMN "budget_period" "AgentRoutineBudgetPeriod",
  ADD COLUMN "estimated_run_cost_cents" INTEGER;

ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_budget_all_or_none_check"
  CHECK (
    (
      "budget_cents" IS NULL AND "budget_currency" IS NULL
      AND "budget_period" IS NULL AND "estimated_run_cost_cents" IS NULL
    ) OR (
      "budget_cents" IS NOT NULL AND "budget_currency" IS NOT NULL
      AND "budget_period" IS NOT NULL AND "estimated_run_cost_cents" IS NOT NULL
    )
  );
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_budget_bounds_check"
  CHECK (
    "budget_cents" IS NULL OR (
      "budget_cents" BETWEEN 1 AND 100000000
      AND "estimated_run_cost_cents" BETWEEN 1 AND "budget_cents"
      AND "budget_currency" ~ '^[A-Z]{3}$'
    )
  );
ALTER TABLE "agent_routines" ADD CONSTRAINT "agent_routines_stop_reason_check"
  CHECK (("stopped_at" IS NULL) = ("stop_reason" IS NULL));

-- AlterTable
ALTER TABLE "agent_routine_dispatches" ADD COLUMN "reserved_cost_cents" INTEGER;
ALTER TABLE "agent_routine_dispatches" ADD CONSTRAINT "agent_routine_dispatches_reserved_cost_check"
  CHECK ("reserved_cost_cents" IS NULL OR "reserved_cost_cents" >= 0);

-- CreateTable
CREATE TABLE "agent_routine_budget_usage" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "routine_id" TEXT NOT NULL,
  "period" "AgentRoutineBudgetPeriod" NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "budget_cents" INTEGER NOT NULL,
  "spent_cents" INTEGER NOT NULL DEFAULT 0,
  "run_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_routine_budget_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_routine_budget_usage_period_key"
  ON "agent_routine_budget_usage"("routine_id", "period", "period_start");
CREATE INDEX "agent_routine_budget_usage_scope_idx"
  ON "agent_routine_budget_usage"("tenant_id", "venue_id", "period_start");

ALTER TABLE "agent_routine_budget_usage" ADD CONSTRAINT "agent_routine_budget_usage_routine_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("routine_id", "tenant_id", "venue_id") REFERENCES "agent_routines"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routine_budget_usage" ADD CONSTRAINT "agent_routine_budget_usage_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "agent_routine_budget_usage" ADD CONSTRAINT "agent_routine_budget_usage_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The database-level overspend guard: no write path, however it races, can record spend above the
-- period budget or a negative amount.
ALTER TABLE "agent_routine_budget_usage" ADD CONSTRAINT "agent_routine_budget_usage_spend_check"
  CHECK ("spent_cents" >= 0 AND "budget_cents" >= 0 AND "spent_cents" <= "budget_cents");
ALTER TABLE "agent_routine_budget_usage" ADD CONSTRAINT "agent_routine_budget_usage_period_check"
  CHECK ("period_end" > "period_start" AND "run_count" >= 0);

COMMIT;
