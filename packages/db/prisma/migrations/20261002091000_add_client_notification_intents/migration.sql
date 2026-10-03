BEGIN;

CREATE TYPE "ClientNotificationEmailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');
CREATE TYPE "ClientNotificationReceiptStatus" AS ENUM (
  'PORTAL_POSTED', 'EMAIL_QUEUED', 'EMAIL_SENT', 'EMAIL_FAILED', 'EMAIL_UNKNOWN'
);

CREATE TABLE "client_notification_intents" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "support_message_id" TEXT NOT NULL,
  "kind" VARCHAR(40) NOT NULL DEFAULT 'INFORMATION_REQUEST',
  "request_version" INTEGER NOT NULL,
  "question_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recipient_user_id" VARCHAR(191) NOT NULL,
  "recipient_email" VARCHAR(320),
  "content_snapshot" JSONB NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "idempotency_key" CHAR(64) NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "email_requested" BOOLEAN NOT NULL,
  "email_status" "ClientNotificationEmailStatus",
  "email_generation" INTEGER NOT NULL DEFAULT 0,
  "email_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "email_provider_message_id" VARCHAR(191),
  "email_last_error_code" VARCHAR(100),
  "email_sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_notification_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_notification_intents_kind_check" CHECK ("kind" IN ('INFORMATION_REQUEST')),
  CONSTRAINT "client_notification_intents_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$' AND "idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "client_notification_intents_actor_check"
    CHECK (char_length(btrim("recipient_user_id")) > 0 AND char_length(btrim("created_by")) > 0),
  CONSTRAINT "client_notification_intents_version_check" CHECK ("request_version" > 0),
  CONSTRAINT "client_notification_intents_email_state_check"
    CHECK (("email_requested" = ("email_status" IS NOT NULL))),
  CONSTRAINT "client_notification_intents_email_sent_check"
    CHECK (("email_status" = 'SENT') = ("email_sent_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "client_notification_intents_tenant_idempotency_key"
  ON "client_notification_intents"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "client_notification_intents_id_tenant_key"
  ON "client_notification_intents"("id", "tenant_id");
CREATE INDEX "client_notification_intents_request_idx"
  ON "client_notification_intents"("tenant_id", "support_request_id", "created_at");
CREATE INDEX "client_notification_intents_email_status_idx"
  ON "client_notification_intents"("email_status", "updated_at");

ALTER TABLE "client_notification_intents"
  ADD CONSTRAINT "client_notification_intents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_notification_intents"
  ADD CONSTRAINT "client_notification_intents_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_notification_intents"
  ADD CONSTRAINT "client_notification_intents_support_request_id_tenant_id_ve_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_notification_intents"
  ADD CONSTRAINT "client_notification_intents_support_message_id_tenant_id_ve_fkey"
  FOREIGN KEY ("support_message_id", "tenant_id", "venue_id", "support_request_id") REFERENCES "support_messages"("id", "tenant_id", "venue_id", "support_request_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "client_notification_receipts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "channel" VARCHAR(10) NOT NULL,
  "status" "ClientNotificationReceiptStatus" NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(100),
  "provider_message_id" VARCHAR(191),
  "actor_id" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_notification_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_notification_receipts_channel_check" CHECK ("channel" IN ('PORTAL', 'EMAIL')),
  CONSTRAINT "client_notification_receipts_channel_status_check" CHECK (
    ("channel" = 'PORTAL' AND "status" = 'PORTAL_POSTED')
    OR ("channel" = 'EMAIL' AND "status" <> 'PORTAL_POSTED')
  )
);

CREATE INDEX "client_notification_receipts_intent_idx"
  ON "client_notification_receipts"("tenant_id", "intent_id", "created_at", "id");

ALTER TABLE "client_notification_receipts"
  ADD CONSTRAINT "client_notification_receipts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_notification_receipts"
  ADD CONSTRAINT "client_notification_receipts_intent_id_tenant_id_fkey"
  FOREIGN KEY ("intent_id", "tenant_id") REFERENCES "client_notification_intents"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Receipts are evidence: they are appended, never changed or removed.
CREATE FUNCTION pathfinder_reject_client_notification_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'client notification receipts are append-only';
END;
$$;
CREATE TRIGGER client_notification_receipts_append_only
  BEFORE UPDATE OR DELETE ON "client_notification_receipts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_client_notification_receipt_mutation();
CREATE TRIGGER client_notification_receipts_no_truncate
  BEFORE TRUNCATE ON "client_notification_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_client_notification_receipt_mutation();

-- An intent's identity and frozen content never change; only its email delivery state does.
CREATE FUNCTION pathfinder_guard_client_notification_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'client notification intents cannot be removed';
  END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR OLD."venue_id" IS DISTINCT FROM NEW."venue_id"
     OR OLD."support_request_id" IS DISTINCT FROM NEW."support_request_id"
     OR OLD."support_message_id" IS DISTINCT FROM NEW."support_message_id"
     OR OLD."kind" IS DISTINCT FROM NEW."kind"
     OR OLD."request_version" IS DISTINCT FROM NEW."request_version"
     OR OLD."question_ids" IS DISTINCT FROM NEW."question_ids"
     OR OLD."recipient_user_id" IS DISTINCT FROM NEW."recipient_user_id"
     OR OLD."recipient_email" IS DISTINCT FROM NEW."recipient_email"
     OR OLD."content_snapshot" IS DISTINCT FROM NEW."content_snapshot"
     OR OLD."content_hash" IS DISTINCT FROM NEW."content_hash"
     OR OLD."idempotency_key" IS DISTINCT FROM NEW."idempotency_key"
     OR OLD."created_by" IS DISTINCT FROM NEW."created_by"
     OR OLD."email_requested" IS DISTINCT FROM NEW."email_requested"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'client notification intent content is immutable';
  END IF;
  IF OLD."email_status" = 'SENT' AND NEW."email_status" IS DISTINCT FROM 'SENT' THEN
    RAISE EXCEPTION 'a sent client notification email cannot be unsent';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER client_notification_intents_guard
  BEFORE UPDATE OR DELETE ON "client_notification_intents"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_client_notification_intent();
CREATE TRIGGER client_notification_intents_no_truncate
  BEFORE TRUNCATE ON "client_notification_intents"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_client_notification_intent();

COMMIT;
