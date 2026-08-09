BEGIN;

CREATE TYPE "AiCostReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');
CREATE TYPE "AiCostSettlementKind" AS ENUM ('EXACT', 'AMBIGUOUS_MAX', 'EXPIRED_MAX', 'OVER_CEILING');

CREATE TABLE "ai_cost_budgets" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "coverage_version" VARCHAR(32) NOT NULL DEFAULT 'gateway-v1',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "limit_units" BIGINT NOT NULL,
  "remaining_units" BIGINT NOT NULL,
  "reserved_units" BIGINT NOT NULL DEFAULT 0,
  "committed_units" BIGINT NOT NULL DEFAULT 0,
  "epoch" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "breached_at" TIMESTAMP(3),
  "updated_by" VARCHAR(191) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_cost_budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_cost_budgets_window_check" CHECK ("starts_at" < "ends_at"),
  CONSTRAINT "ai_cost_budgets_limit_check" CHECK ("limit_units" > 0),
  CONSTRAINT "ai_cost_budgets_counter_check" CHECK (
    "remaining_units" >= 0 AND "reserved_units" >= 0 AND "committed_units" >= 0
  ),
  CONSTRAINT "ai_cost_budgets_epoch_revision_check" CHECK ("epoch" >= 1 AND "revision" >= 1),
  CONSTRAINT "ai_cost_budgets_balance_check" CHECK (
    ("breached_at" IS NULL AND "remaining_units" + "reserved_units" + "committed_units" = "limit_units")
    OR
    (
      "breached_at" IS NOT NULL
      AND "remaining_units" + "reserved_units" + "committed_units" >= "limit_units"
    )
  )
);

CREATE TABLE "ai_cost_reservations" (
  "id" UUID NOT NULL,
  "budget_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "budget_epoch" INTEGER NOT NULL,
  "invocation_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "feature" VARCHAR(100) NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "model" VARCHAR(191) NOT NULL,
  "pricing_version" VARCHAR(100) NOT NULL,
  "reserved_units" BIGINT NOT NULL,
  "settled_units" BIGINT,
  "status" "AiCostReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "settlement_kind" "AiCostSettlementKind",
  "expires_at" TIMESTAMP(3) NOT NULL,
  "dispatch_started_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_cost_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_cost_reservations_identity_check" CHECK (
    "budget_epoch" >= 1 AND "attempt_number" >= 1 AND "reserved_units" > 0
  ),
  CONSTRAINT "ai_cost_reservations_state_check" CHECK (
    (
      "status" = 'RESERVED'
      AND "settled_units" IS NULL
      AND "settlement_kind" IS NULL
      AND "resolved_at" IS NULL
    )
    OR
    (
      "status" = 'RELEASED'
      AND "settled_units" = 0
      AND "settlement_kind" IS NULL
      AND "dispatch_started_at" IS NULL
      AND "resolved_at" IS NOT NULL
    )
    OR
    (
      "status" = 'SETTLED'
      AND "settled_units" IS NOT NULL
      AND "settled_units" >= 0
      AND "settlement_kind" IS NOT NULL
      AND ("settlement_kind" = 'EXPIRED_MAX' OR "dispatch_started_at" IS NOT NULL)
      AND "resolved_at" IS NOT NULL
    )
  ),
  CONSTRAINT "ai_cost_reservations_settlement_check" CHECK (
    "status" <> 'SETTLED'
    OR ("settlement_kind" = 'OVER_CEILING' AND "settled_units" > "reserved_units")
    OR ("settlement_kind" = 'EXACT' AND "settled_units" <= "reserved_units")
    OR ("settlement_kind" IN ('AMBIGUOUS_MAX', 'EXPIRED_MAX') AND "settled_units" = "reserved_units")
  )
);

CREATE UNIQUE INDEX "ai_cost_budgets_tenant_id_coverage_version_key"
  ON "ai_cost_budgets"("tenant_id", "coverage_version");
CREATE UNIQUE INDEX "ai_cost_budgets_id_tenant_id_key"
  ON "ai_cost_budgets"("id", "tenant_id");
CREATE INDEX "ai_cost_budgets_tenant_id_enabled_idx"
  ON "ai_cost_budgets"("tenant_id", "enabled");

CREATE UNIQUE INDEX "ai_cost_reservations_attempt_key"
  ON "ai_cost_reservations"("budget_id", "budget_epoch", "invocation_id", "attempt_number");
CREATE INDEX "ai_cost_reservations_tenant_id_venue_id_created_at_idx"
  ON "ai_cost_reservations"("tenant_id", "venue_id", "created_at");
CREATE INDEX "ai_cost_reservations_status_expires_at_idx"
  ON "ai_cost_reservations"("status", "expires_at");

ALTER TABLE "ai_cost_budgets"
  ADD CONSTRAINT "ai_cost_budgets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_cost_reservations"
  ADD CONSTRAINT "ai_cost_reservations_budget_id_tenant_id_fkey"
  FOREIGN KEY ("budget_id", "tenant_id") REFERENCES "ai_cost_budgets"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_cost_reservations"
  ADD CONSTRAINT "ai_cost_reservations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ai_cost_reservations"
  ADD CONSTRAINT "ai_cost_reservations_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
