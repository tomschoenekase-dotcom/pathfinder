BEGIN;

ALTER TABLE "weekly_reports"
  ALTER COLUMN "title" SET DEFAULT 'Torchico Weekly Report';

UPDATE "weekly_reports"
SET "title" = 'Torchico Weekly Report'
WHERE "title" = 'PathFinder Weekly Report';

COMMIT;
