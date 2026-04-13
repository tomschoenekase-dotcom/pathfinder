-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "place_id" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_rollups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "metric" TEXT NOT NULL,
    "place_id" TEXT,
    "category" TEXT,
    "value" INTEGER NOT NULL,

    CONSTRAINT "daily_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_events_tenant_id_venue_id_occurred_at_idx" ON "analytics_events"("tenant_id", "venue_id", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_session_id_idx" ON "analytics_events"("session_id");

-- CreateIndex
CREATE INDEX "analytics_events_event_type_occurred_at_idx" ON "analytics_events"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_place_id_idx" ON "analytics_events"("place_id");

-- CreateIndex
CREATE INDEX "guest_sessions_tenant_id_venue_id_idx" ON "guest_sessions"("tenant_id", "venue_id");

-- CreateIndex
CREATE INDEX "guest_sessions_last_seen_at_idx" ON "guest_sessions"("last_seen_at");

-- CreateIndex
CREATE INDEX "daily_rollups_tenant_id_venue_id_date_idx" ON "daily_rollups"("tenant_id", "venue_id", "date");

-- CreateIndex
CREATE INDEX "daily_rollups_metric_date_idx" ON "daily_rollups"("metric", "date");

-- CreateIndex
CREATE INDEX "daily_rollups_place_id_idx" ON "daily_rollups"("place_id");

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
