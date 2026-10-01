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

COMMIT;
