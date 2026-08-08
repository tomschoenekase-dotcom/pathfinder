-- Status/disposition coupling is intentionally deferred until every old worker has
-- been drained. During a rolling deploy, an old worker can move a retry from FAILED
-- to RUNNING or COMPLETE without knowing to clear the additive lifecycle columns.
ALTER TABLE "job_records"
  DROP CONSTRAINT "job_records_failure_lifecycle_check";
