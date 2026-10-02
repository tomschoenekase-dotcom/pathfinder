BEGIN;

-- Venue-approved, read-only live data feeds (pull mode) and their latest stored observation.
-- Forward-only and additive: two new tenant-scoped tables, no change to existing rows.
-- No credentials are stored. Connectors are created DISABLED and fetch nothing until enabled.

-- CreateEnum
CREATE TYPE "LiveDataConnectorKind" AS ENUM ('SPORTS_SCORE', 'RIDE_STATUS', 'GENERIC_JSON');

-- CreateEnum
CREATE TYPE "LiveDataConnectorState" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "live_data_connectors" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "LiveDataConnectorKind" NOT NULL,
    "provider" VARCHAR(80) NOT NULL,
    "resource_id" VARCHAR(80) NOT NULL,
    "resource_label" VARCHAR(120) NOT NULL,
    "endpoint_url" VARCHAR(2048) NOT NULL,
    "endpoint_host" VARCHAR(255) NOT NULL,
    "mapping" JSONB NOT NULL,
    "poll_interval_seconds" INTEGER NOT NULL,
    "freshness_budget_seconds" INTEGER NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "state" "LiveDataConnectorState" NOT NULL DEFAULT 'DISABLED',
    "next_poll_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error_category" VARCHAR(32),
    "last_error_at" TIMESTAMP(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_test_at" TIMESTAMP(3),
    "last_test_outcome" VARCHAR(16),
    "last_test_error_category" VARCHAR(32),
    "last_test_preview" JSONB,
    "created_by" VARCHAR(191) NOT NULL,
    "updated_by" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_data_connectors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "live_data_connectors_poll_interval_check" CHECK ("poll_interval_seconds" BETWEEN 15 AND 3600),
    CONSTRAINT "live_data_connectors_freshness_check" CHECK ("freshness_budget_seconds" BETWEEN 15 AND 86400 AND "freshness_budget_seconds" >= "poll_interval_seconds")
);

-- CreateTable
CREATE TABLE "live_data_observations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "observed_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "timestamp_basis" VARCHAR(16) NOT NULL,
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_data_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_data_connectors_id_tenant_id_key" ON "live_data_connectors"("id", "tenant_id");
CREATE UNIQUE INDEX "live_data_connectors_tenant_id_venue_id_resource_id_key" ON "live_data_connectors"("tenant_id", "venue_id", "resource_id");
CREATE INDEX "live_data_connectors_tenant_id_venue_id_state_idx" ON "live_data_connectors"("tenant_id", "venue_id", "state");
CREATE INDEX "live_data_connectors_state_next_poll_at_idx" ON "live_data_connectors"("state", "next_poll_at");
CREATE UNIQUE INDEX "live_data_observations_connector_id_key" ON "live_data_observations"("connector_id");
CREATE UNIQUE INDEX "live_data_observations_connector_id_tenant_id_key" ON "live_data_observations"("connector_id", "tenant_id");
CREATE INDEX "live_data_observations_tenant_id_venue_id_idx" ON "live_data_observations"("tenant_id", "venue_id");

-- AddForeignKey
ALTER TABLE "live_data_connectors"
  ADD CONSTRAINT "live_data_connectors_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "live_data_observations"
  ADD CONSTRAINT "live_data_observations_connector_fkey"
  FOREIGN KEY ("connector_id", "tenant_id") REFERENCES "live_data_connectors"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
