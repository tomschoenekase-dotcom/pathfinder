BEGIN;

ALTER TABLE "support_messages"
  ADD COLUMN "submission_request_id" UUID,
  ADD COLUMN "submission_input_hash" CHAR(64);

ALTER TABLE "support_messages"
  ADD CONSTRAINT "support_messages_submission_identity_pair_check"
  CHECK (
    ("submission_request_id" IS NULL AND "submission_input_hash" IS NULL)
    OR
    (
      "submission_request_id" IS NOT NULL
      AND "submission_input_hash" IS NOT NULL
      AND "submission_input_hash" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX "support_messages_tenant_submission_request_key"
  ON "support_messages"("tenant_id", "submission_request_id");

ALTER TABLE "support_message_attachments"
  ADD COLUMN "intake_upload_id" VARCHAR(191);

ALTER TABLE "support_message_attachments"
  ADD CONSTRAINT "support_message_attachments_intake_upload_scope_fkey"
  FOREIGN KEY ("intake_upload_id", "tenant_id", "venue_id")
  REFERENCES "intake_uploads"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "support_message_attachments_intake_upload_scope_idx"
  ON "support_message_attachments"("tenant_id", "venue_id", "intake_upload_id");

CREATE UNIQUE INDEX "support_message_attachments_message_upload_key"
  ON "support_message_attachments"("support_message_id", "tenant_id", "venue_id", "intake_upload_id");

COMMIT;
