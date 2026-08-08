-- DailyRollup has two nullable logical dimensions. Four mutually exclusive
-- partial indexes make NULL values equal for replacement identity without a
-- sentinel value or a PostgreSQL 15+ NULLS NOT DISTINCT requirement.
--
-- This migration intentionally fails if historical duplicate logical keys
-- exist. There is no safe arbitrary winner; audit and recompute those groups
-- before applying this migration to a populated environment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "daily_rollups"
    GROUP BY
      "tenant_id",
      "venue_id",
      "date",
      "metric",
      "place_id",
      "category"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'DailyRollup logical duplicates must be audited and recomputed before adding uniqueness indexes';
  END IF;
END
$$;

-- Keep the four index builds atomic so a failure cannot leave only a subset.
BEGIN;

CREATE UNIQUE INDEX "daily_rollups_scope_no_dims_key"
ON "daily_rollups"("tenant_id", "venue_id", "date", "metric")
WHERE "place_id" IS NULL AND "category" IS NULL;

CREATE UNIQUE INDEX "daily_rollups_scope_place_key"
ON "daily_rollups"("tenant_id", "venue_id", "date", "metric", "place_id")
WHERE "place_id" IS NOT NULL AND "category" IS NULL;

CREATE UNIQUE INDEX "daily_rollups_scope_category_key"
ON "daily_rollups"("tenant_id", "venue_id", "date", "metric", "category")
WHERE "place_id" IS NULL AND "category" IS NOT NULL;

CREATE UNIQUE INDEX "daily_rollups_scope_place_category_key"
ON "daily_rollups"(
  "tenant_id",
  "venue_id",
  "date",
  "metric",
  "place_id",
  "category"
)
WHERE "place_id" IS NOT NULL AND "category" IS NOT NULL;

COMMIT;
