BEGIN;

-- Operator program foundations. Forward-only and additive: new nullable columns and indexes only.
-- No existing row changes meaning, no existing writer needs to change, and nothing here grants
-- authority or enables any behavior by itself.

-- A stable, provider-namespaced receipt for an externally observed message ("provider:account:id").
-- A database-unique key replaces check-then-create deduplication when two writers log the same
-- message at once. Rows without a receipt (all rows written before this migration) stay null.
ALTER TABLE "prospect_activities" ADD COLUMN "external_receipt_key" VARCHAR(512);

-- Preserve existing operator-logged sends as receipts with an unspecified mailbox. If the same
-- message was logged more than once before this migration, only the earliest row takes the key so
-- the unique index can be created without altering or deleting any history.
UPDATE "prospect_activities" AS activity
SET "external_receipt_key" = 'gmail:unspecified:' || first_row.message_id
FROM (
  SELECT DISTINCT ON ("evidence"->>'gmailMessageId')
    "id",
    "evidence"->>'gmailMessageId' AS message_id
  FROM "prospect_activities"
  WHERE "type" = 'OUTREACH_SENT'
    AND "evidence"->>'source' = 'operator-gmail'
    AND "evidence"->>'gmailMessageId' IS NOT NULL
    AND length("evidence"->>'gmailMessageId') BETWEEN 1 AND 400
  ORDER BY "evidence"->>'gmailMessageId', "created_at", "id"
) AS first_row
WHERE activity."id" = first_row."id";

CREATE UNIQUE INDEX "prospect_activities_external_receipt_key_key"
  ON "prospect_activities"("external_receipt_key");

-- Durable execution: an apply claim is a lease with a fencing token, and the moment a domain write
-- may begin is recorded. Together they let a reconciler tell "never started, safe to retry" from
-- "may have committed, outcome unknown", and stop a stale worker from recording a result after a
-- newer claim. Existing rows keep attempt 0 and are interpreted by the legacy rules.
ALTER TABLE "operator_proposals"
  ADD COLUMN "apply_started_at" TIMESTAMP(3),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "fence_token" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "operator_plans"
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "fence_token" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "operator_proposals_status_lease_idx"
  ON "operator_proposals"("status", "lease_expires_at");
CREATE INDEX "operator_plans_status_lease_idx"
  ON "operator_plans"("status", "lease_expires_at");

-- Authority: an AUTO switch applies only to the kinds it names (an empty list keeps the old
-- meaning for the kinds that existed before this migration and nothing newer), every policy change
-- bumps one revision, and a proposal remembers the exact preview and policy revision it was
-- created under so a later change forces a fresh preview instead of riding an old approval.
ALTER TABLE "operator_autonomy_policies"
  ADD COLUMN "allowed_kinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "operator_policy_state" (
  "id" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_policy_state_pkey" PRIMARY KEY ("id")
);
INSERT INTO "operator_policy_state" ("id", "revision") VALUES ('singleton', 0);

ALTER TABLE "operator_proposals"
  ADD COLUMN "preview_digest" CHAR(64),
  ADD COLUMN "policy_revision" INTEGER;

-- Admission control: one atomic counter per (key, fixed window). A call is admitted by the same
-- statement that counts it, so concurrent callers cannot all pass a check-then-execute gap and a
-- denied retry only increments a number instead of writing another audit row.
CREATE TABLE "operator_admission_counters" (
  "key" VARCHAR(191) NOT NULL,
  "window_start" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "operator_admission_counters_pkey" PRIMARY KEY ("key", "window_start")
);
CREATE INDEX "operator_admission_counters_window_idx" ON "operator_admission_counters"("window_start");

COMMIT;
