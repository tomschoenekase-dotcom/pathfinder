CREATE TABLE "encrypted_integration_credentials" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "subject" VARCHAR(320) NOT NULL,
    "encrypted_secret" BYTEA NOT NULL,
    "initialization_vector" BYTEA NOT NULL,
    "authentication_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" VARCHAR(191) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "encrypted_integration_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "encrypted_integration_credentials_key_version_positive" CHECK ("key_version" > 0)
);

CREATE INDEX "encrypted_integration_credentials_provider_subject_revoked_at_idx"
ON "encrypted_integration_credentials"("provider", "subject", "revoked_at");

CREATE TABLE "gmail_oauth_attempts" (
    "id" TEXT NOT NULL,
    "state_hash" CHAR(64) NOT NULL,
    "encrypted_code_verifier" BYTEA NOT NULL,
    "initialization_vector" BYTEA NOT NULL,
    "authentication_tag" BYTEA NOT NULL,
    "redirect_uri" VARCHAR(1000) NOT NULL,
    "requested_by" VARCHAR(191) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gmail_oauth_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_oauth_attempts_state_hash_key" ON "gmail_oauth_attempts"("state_hash");
CREATE INDEX "gmail_oauth_attempts_expires_at_consumed_at_idx"
ON "gmail_oauth_attempts"("expires_at", "consumed_at");

ALTER TABLE "prospect_email_webhook_receipts"
ADD COLUMN "provider_mailbox_key" VARCHAR(320);

UPDATE "prospect_email_webhook_receipts"
SET "provider_mailbox_key" = COALESCE("provider_account_id", 'legacy-unresolved');

ALTER TABLE "prospect_email_webhook_receipts"
ALTER COLUMN "provider_mailbox_key" SET NOT NULL;

CREATE UNIQUE INDEX "prospect_email_receipts_provider_mailbox_event_key"
ON "prospect_email_webhook_receipts"("provider", "provider_mailbox_key", "provider_event_id");
