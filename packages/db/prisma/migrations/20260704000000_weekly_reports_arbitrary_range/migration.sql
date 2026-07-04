-- DropIndex
-- Reports are no longer restricted to one-per-venue-per-week — the admin can generate
-- multiple reports covering any custom date range, each with its own title.
DROP INDEX "weekly_reports_venue_id_week_start_key";

-- CreateIndex
CREATE INDEX "weekly_reports_venue_id_week_start_idx" ON "weekly_reports"("venue_id", "week_start");
