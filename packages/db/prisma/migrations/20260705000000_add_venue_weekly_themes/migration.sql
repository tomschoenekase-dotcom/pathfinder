-- CreateTable
CREATE TABLE "venue_weekly_themes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "week_start" TIMESTAMP(3) NOT NULL,
    "week_end" TIMESTAMP(3) NOT NULL,
    "themes" JSONB NOT NULL DEFAULT '[]',
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_weekly_themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venue_weekly_themes_tenant_id_week_start_idx" ON "venue_weekly_themes"("tenant_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "venue_weekly_themes_tenant_id_venue_id_week_start_key" ON "venue_weekly_themes"("tenant_id", "venue_id", "week_start");

-- AddForeignKey
ALTER TABLE "venue_weekly_themes" ADD CONSTRAINT "venue_weekly_themes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_weekly_themes" ADD CONSTRAINT "venue_weekly_themes_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
