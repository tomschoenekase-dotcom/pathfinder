-- Keep the database discriminator aligned with the application-level v4 evaluation
-- identity added in 20260819020000. Approved onboarding packages are immutable,
-- referenced snapshots and therefore require the same positive-version guarantees as
-- native release snapshots.
ALTER TABLE "eval_runs"
  DROP CONSTRAINT "eval_runs_content_snapshot_shape_check";

ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_content_snapshot_shape_check" CHECK (
  ("content_snapshot_kind" = 'LEGACY_VENUE_CONTENT_V1' AND "content_snapshot_ref" IS NULL AND "content_snapshot_version" >= 0)
  OR
  ("content_snapshot_kind" = 'NATIVE_CORE_V1' AND "content_snapshot_ref" IS NOT NULL AND btrim("content_snapshot_ref") <> '' AND "content_snapshot_version" > 0)
  OR
  ("content_snapshot_kind" = 'APPROVED_VENUE_PACKAGE_V1' AND "content_snapshot_ref" IS NOT NULL AND btrim("content_snapshot_ref") <> '' AND "content_snapshot_version" > 0)
);
