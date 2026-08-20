CREATE TYPE "OperationalEventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');
CREATE TYPE "OperationalEventState" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'EXPIRED');
CREATE TYPE "OperationalEventDeliveryChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH', 'SLACK', 'WEBHOOK');
CREATE TYPE "OperationalEventDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

CREATE TABLE "operational_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT,
  "event_type" VARCHAR(100) NOT NULL,
  "source_subsystem" VARCHAR(64) NOT NULL,
  "severity" "OperationalEventSeverity" NOT NULL DEFAULT 'INFO',
  "title" VARCHAR(191) NOT NULL,
  "summary" VARCHAR(2000) NOT NULL,
  "action_required" BOOLEAN NOT NULL DEFAULT false,
  "linked_object_type" VARCHAR(64),
  "linked_object_id" VARCHAR(191),
  "recommended_action" VARCHAR(1000),
  "state" "OperationalEventState" NOT NULL DEFAULT 'OPEN',
  "deduplication_key" VARCHAR(191) NOT NULL,
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "last_occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "read_at" TIMESTAMP(3),
  "read_by" VARCHAR(191),
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_by" VARCHAR(191),
  "resolved_at" TIMESTAMP(3),
  "resolved_by" VARCHAR(191),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "operational_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_events_occurrence_count_check" CHECK ("occurrence_count" > 0),
  CONSTRAINT "operational_events_venue_link_check" CHECK (
    ("linked_object_type" IS NULL AND "linked_object_id" IS NULL) OR
    ("linked_object_type" IS NOT NULL AND "linked_object_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "operational_events_tenant_deduplication_key" ON "operational_events"("tenant_id", "deduplication_key");
CREATE UNIQUE INDEX "operational_events_id_tenant_key" ON "operational_events"("id", "tenant_id");
CREATE INDEX "operational_events_tenant_id_venue_id_state_severity_created_idx" ON "operational_events"("tenant_id", "venue_id", "state", "severity", "created_at");
CREATE INDEX "operational_events_platform_attention_idx" ON "operational_events"("state", "severity", "created_at");
CREATE INDEX "operational_events_tenant_id_event_type_last_occurred_at_idx" ON "operational_events"("tenant_id", "event_type", "last_occurred_at");

ALTER TABLE "operational_events"
  ADD CONSTRAINT "operational_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "operational_events_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "operational_event_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "event_id" UUID NOT NULL,
  "channel" "OperationalEventDeliveryChannel" NOT NULL,
  "destination_key" VARCHAR(191),
  "status" "OperationalEventDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(100),
  "next_attempt_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "operational_event_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_event_deliveries_attempt_count_check" CHECK ("attempt_count" >= 0)
);

CREATE UNIQUE INDEX "operational_event_deliveries_target_key" ON "operational_event_deliveries"("event_id", "channel", "destination_key");
CREATE INDEX "operational_event_deliveries_tenant_id_status_next_attempt_at_idx" ON "operational_event_deliveries"("tenant_id", "status", "next_attempt_at");

ALTER TABLE "operational_event_deliveries"
  ADD CONSTRAINT "operational_event_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "operational_event_deliveries_event_id_tenant_id_fkey" FOREIGN KEY ("event_id", "tenant_id") REFERENCES "operational_events"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
