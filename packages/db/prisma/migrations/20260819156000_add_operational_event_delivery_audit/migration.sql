CREATE UNIQUE INDEX "operational_event_deliveries_id_tenant_key"
  ON "operational_event_deliveries"("id", "tenant_id");

CREATE TABLE "operational_event_delivery_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "delivery_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "status" "OperationalEventDeliveryStatus" NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "provider_ref" VARCHAR(191),
  "error_code" VARCHAR(100),
  "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_event_delivery_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_event_delivery_attempts_number_check" CHECK ("attempt_number" > 0)
);

CREATE UNIQUE INDEX "operational_event_delivery_attempt_number_key"
  ON "operational_event_delivery_attempts"("delivery_id", "attempt_number");
CREATE INDEX "operational_event_delivery_attempts_tenant_id_attempted_at_idx"
  ON "operational_event_delivery_attempts"("tenant_id", "attempted_at");

ALTER TABLE "operational_event_delivery_attempts"
  ADD CONSTRAINT "operational_event_delivery_attempts_delivery_id_tenant_id_fkey"
  FOREIGN KEY ("delivery_id", "tenant_id")
  REFERENCES "operational_event_deliveries"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
