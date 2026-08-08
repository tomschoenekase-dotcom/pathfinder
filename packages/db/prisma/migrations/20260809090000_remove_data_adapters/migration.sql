BEGIN;

-- DataAdapter was unused scaffolding. Hold an exclusive lock across the
-- emptiness proof and drop so an unexpected writer cannot race the check.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "data_adapters" IN ACCESS EXCLUSIVE MODE;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM "data_adapters" LIMIT 1) THEN
    RAISE EXCEPTION
      'data_adapters contains rows; export and reconcile them before removing the placeholder';
  END IF;
END
$migration$;

DROP TABLE "data_adapters";

COMMIT;
