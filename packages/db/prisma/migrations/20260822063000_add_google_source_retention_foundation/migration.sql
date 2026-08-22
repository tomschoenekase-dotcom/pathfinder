CREATE TYPE "GmailBodyRetentionState" AS ENUM (
  'NOT_STORED',
  'TEMPORARY',
  'LEGACY_REVIEW_REQUIRED',
  'LEGAL_HOLD',
  'REMOVED'
);

ALTER TABLE "prospect_email_messages"
  ADD COLUMN "body_preview" VARCHAR(500),
  ADD COLUMN "body_retention_state" "GmailBodyRetentionState" NOT NULL DEFAULT 'NOT_STORED',
  ADD COLUMN "body_expires_at" TIMESTAMP(3),
  ADD COLUMN "body_removed_at" TIMESTAMP(3),
  ADD COLUMN "source_reference" VARCHAR(1000);

-- Preserve every existing body and route it to explicit review. This migration performs no purge.
UPDATE "prospect_email_messages"
SET
  "body_retention_state" = 'LEGACY_REVIEW_REQUIRED',
  "body_preview" = LEFT(REGEXP_REPLACE(COALESCE("text_body", ''), '\\s+', ' ', 'g'), 500)
WHERE "text_body" IS NOT NULL OR "html_body" IS NOT NULL;

CREATE INDEX "prospect_email_messages_body_retention_idx"
  ON "prospect_email_messages"("body_retention_state", "body_expires_at");

ALTER TABLE "prospect_email_messages"
  ADD CONSTRAINT "prospect_email_messages_body_retention_consistency_check"
  CHECK (
    ("body_retention_state" IN ('NOT_STORED', 'REMOVED') AND "text_body" IS NULL AND "html_body" IS NULL)
    OR ("body_retention_state" = 'TEMPORARY' AND "body_expires_at" IS NOT NULL AND ("text_body" IS NOT NULL OR "html_body" IS NOT NULL))
    OR ("body_retention_state" IN ('LEGACY_REVIEW_REQUIRED', 'LEGAL_HOLD'))
  );
