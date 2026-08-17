-- Preserve applied migration history while advancing all default and legacy
-- report titles to the final public product name.
ALTER TABLE "weekly_reports"
  ALTER COLUMN "title" SET DEFAULT 'Torchiko Weekly Report';

UPDATE "weekly_reports"
SET "title" = 'Torchiko Weekly Report'
WHERE "title" IN ('Torchico Weekly Report', 'PathFinder Weekly Report');
