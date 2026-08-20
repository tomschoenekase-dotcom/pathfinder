CREATE TABLE "platform_operational_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    CONSTRAINT "platform_operational_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_operational_events_link_pair" CHECK (("linked_object_type" IS NULL) = ("linked_object_id" IS NULL)),
    CONSTRAINT "platform_operational_events_occurrence_positive" CHECK ("occurrence_count" > 0)
);

CREATE UNIQUE INDEX "platform_operational_events_deduplication_key_key"
ON "platform_operational_events"("deduplication_key");
CREATE INDEX "platform_operational_events_state_severity_created_at_idx"
ON "platform_operational_events"("state", "severity", "created_at");
CREATE INDEX "platform_operational_events_event_type_last_occurred_at_idx"
ON "platform_operational_events"("event_type", "last_occurred_at");
