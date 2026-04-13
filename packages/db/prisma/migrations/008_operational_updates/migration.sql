-- CreateEnum (skipped — type already exists from a prior migration)
-- CREATE TYPE "OperationalUpdateSeverity" AS ENUM ('INFO', 'WARNING', 'CLOSURE', 'REDIRECT');

-- CreateTable
CREATE TABLE "operational_updates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "place_id" TEXT,
    "severity" "OperationalUpdateSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "redirect_to" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operational_updates_tenant_id_idx" ON "operational_updates"("tenant_id");

-- CreateIndex
CREATE INDEX "operational_updates_venue_id_is_active_expires_at_idx" ON "operational_updates"("venue_id", "is_active", "expires_at");

-- CreateIndex
CREATE INDEX "operational_updates_place_id_idx" ON "operational_updates"("place_id");

-- CreateIndex
CREATE INDEX "operational_updates_severity_created_at_idx" ON "operational_updates"("severity", "created_at");

-- AddForeignKey
ALTER TABLE "operational_updates" ADD CONSTRAINT "operational_updates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_updates" ADD CONSTRAINT "operational_updates_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_updates" ADD CONSTRAINT "operational_updates_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
