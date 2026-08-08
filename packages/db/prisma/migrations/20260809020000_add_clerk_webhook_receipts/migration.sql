BEGIN;

CREATE TABLE "clerk_webhook_receipts" (
  "provider_event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "welcome_email_membership_id" TEXT,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clerk_webhook_receipts_pkey" PRIMARY KEY ("provider_event_id"),
  CONSTRAINT "clerk_webhook_receipts_provider_event_id_check"
    CHECK (char_length("provider_event_id") BETWEEN 1 AND 255),
  CONSTRAINT "clerk_webhook_receipts_event_type_check"
    CHECK (char_length("event_type") BETWEEN 1 AND 100),
  CONSTRAINT "clerk_webhook_receipts_payload_hash_check"
    CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clerk_webhook_receipts_welcome_membership_check"
    CHECK (
      "welcome_email_membership_id" IS NULL OR
      char_length("welcome_email_membership_id") BETWEEN 1 AND 255
    )
);

ALTER TABLE "tenant_memberships"
  ADD COLUMN "clerk_event_timestamp" BIGINT NOT NULL
    DEFAULT (FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000))::BIGINT,
  ADD COLUMN "clerk_cursor_is_cutover_baseline" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "welcome_email_attempted_at" TIMESTAMP(3),
  ADD COLUMN "welcome_email_delivered_at" TIMESTAMP(3),
  ADD CONSTRAINT "tenant_memberships_clerk_event_timestamp_check"
    CHECK ("clerk_event_timestamp" >= 0);

-- Existing membership state becomes the cutover baseline. Runtime ordering accepts only
-- privilege reductions/removals from older delayed events until a post-cutover event advances it;
-- older escalation or reactivation cannot replace this baseline.
CREATE INDEX "clerk_webhook_receipts_created_at_idx"
  ON "clerk_webhook_receipts"("created_at");

COMMIT;
