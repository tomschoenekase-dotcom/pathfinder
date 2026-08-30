BEGIN;

CREATE TYPE "FirstWeekReviewMilestone" AS ENUM ('DAY_1', 'DAY_3', 'DAY_7');
CREATE TYPE "FirstWeekReviewDisposition" AS ENUM ('NO_ACTION', 'DRAFT_READY');

CREATE UNIQUE INDEX "onboarding_milestone_events_id_scope_key"
  ON "onboarding_milestone_events"("id", "tenant_id", "venue_id");

CREATE TABLE "first_week_account_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "release_milestone_event_id" UUID NOT NULL,
  "milestone" "FirstWeekReviewMilestone" NOT NULL,
  "review_version" INTEGER NOT NULL DEFAULT 1,
  "release_at" TIMESTAMP(3) NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  "metrics" JSONB NOT NULL,
  "disposition" "FirstWeekReviewDisposition" NOT NULL,
  "draft_subject" VARCHAR(191),
  "draft_body" VARCHAR(4000),
  "draft_reason" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "first_week_account_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "first_week_account_reviews_version_check" CHECK ("review_version" = 1),
  CONSTRAINT "first_week_account_reviews_window_check" CHECK ("due_at" > "release_at"),
  CONSTRAINT "first_week_account_reviews_snapshot_hash_check"
    CHECK ("snapshot_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "first_week_account_reviews_metrics_object_check"
    CHECK (jsonb_typeof("metrics") = 'object'),
  CONSTRAINT "first_week_account_reviews_draft_check" CHECK (
    (
      "disposition" = 'NO_ACTION'
      AND "draft_subject" IS NULL
      AND "draft_body" IS NULL
      AND "draft_reason" IS NULL
    ) OR (
      "disposition" = 'DRAFT_READY'
      AND length(btrim("draft_subject")) > 0
      AND length(btrim("draft_body")) > 0
      AND length(btrim("draft_reason")) > 0
    )
  )
);

CREATE UNIQUE INDEX "first_week_account_reviews_milestone_key"
  ON "first_week_account_reviews"(
    "tenant_id", "venue_id", "release_milestone_event_id", "milestone"
  );
CREATE UNIQUE INDEX "first_week_account_reviews_snapshot_hash_key"
  ON "first_week_account_reviews"("snapshot_hash");
CREATE INDEX "first_week_account_reviews_timeline_idx"
  ON "first_week_account_reviews"("tenant_id", "venue_id", "due_at", "id");
CREATE INDEX "first_week_account_reviews_attention_idx"
  ON "first_week_account_reviews"("tenant_id", "disposition", "due_at", "id");

ALTER TABLE "first_week_account_reviews"
  ADD CONSTRAINT "first_week_account_reviews_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "first_week_account_reviews"
  ADD CONSTRAINT "first_week_account_reviews_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "first_week_account_reviews"
  ADD CONSTRAINT "first_week_account_reviews_release_event_fkey"
  FOREIGN KEY ("release_milestone_event_id", "tenant_id", "venue_id")
  REFERENCES "onboarding_milestone_events"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "first_week_account_reviews_append_only_update_delete"
  BEFORE UPDATE OR DELETE ON "first_week_account_reviews"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "first_week_account_reviews_append_only_truncate"
  BEFORE TRUNCATE ON "first_week_account_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

COMMIT;

