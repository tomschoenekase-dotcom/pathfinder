BEGIN;

-- Outbound anchor: the RFC Message-ID minted when a client notification email is claimed.
ALTER TABLE "client_notification_intents" ADD COLUMN "email_rfc_message_id" VARCHAR(998);
ALTER TABLE "client_notification_intents"
  ADD CONSTRAINT "client_notification_intents_rfc_message_id_check"
  CHECK (
    "email_rfc_message_id" IS NULL OR (
      char_length("email_rfc_message_id") BETWEEN 10 AND 998
      AND "email_rfc_message_id" ~ '^<[^<>[:space:]]+>$'
    )
  );
CREATE UNIQUE INDEX "client_notification_intents_rfc_message_id_key"
  ON "client_notification_intents"("email_rfc_message_id");

-- Linked replies: tenant, venue and request come from the matched outbound record.
CREATE TABLE "client_inbound_replies" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "intent_id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "mailbox_id" VARCHAR(191) NOT NULL,
  "provider_message_id" VARCHAR(191) NOT NULL,
  "provider_thread_id" VARCHAR(191),
  "rfc_message_id" VARCHAR(998),
  "in_reply_to" VARCHAR(998),
  "match_evidence" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sender_hash" CHAR(64) NOT NULL,
  "body_preview" VARCHAR(500) NOT NULL,
  "body_sha256" CHAR(64) NOT NULL,
  "body_bytes" INTEGER NOT NULL,
  "request_effect" VARCHAR(32) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_inbound_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_inbound_replies_hash_check"
    CHECK ("sender_hash" ~ '^[0-9a-f]{64}$' AND "body_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "client_inbound_replies_effect_check"
    CHECK ("request_effect" IN ('MOVED_TO_IN_REVIEW', 'NO_CHANGE')),
  CONSTRAINT "client_inbound_replies_evidence_check" CHECK (cardinality("match_evidence") > 0),
  CONSTRAINT "client_inbound_replies_bytes_check" CHECK ("body_bytes" >= 0)
);

CREATE UNIQUE INDEX "client_inbound_replies_provider_message_key"
  ON "client_inbound_replies"("provider", "mailbox_id", "provider_message_id");
CREATE INDEX "client_inbound_replies_request_idx"
  ON "client_inbound_replies"("tenant_id", "support_request_id", "received_at", "id");
CREATE INDEX "client_inbound_replies_thread_idx"
  ON "client_inbound_replies"("provider", "mailbox_id", "provider_thread_id");
CREATE INDEX "client_inbound_replies_rfc_message_idx"
  ON "client_inbound_replies"("rfc_message_id");

ALTER TABLE "client_inbound_replies"
  ADD CONSTRAINT "client_inbound_replies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_inbound_replies"
  ADD CONSTRAINT "client_inbound_replies_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_inbound_replies"
  ADD CONSTRAINT "client_inbound_replies_support_request_id_tenant_id_venue_i_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "client_inbound_replies"
  ADD CONSTRAINT "client_inbound_replies_intent_id_tenant_id_fkey"
  FOREIGN KEY ("intent_id", "tenant_id") REFERENCES "client_notification_intents"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Triage queue for messages that cannot be linked safely. Platform-owned: no tenant exists.
CREATE TABLE "client_inbound_quarantines" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "mailbox_id" VARCHAR(191) NOT NULL,
  "provider_message_id" VARCHAR(191) NOT NULL,
  "provider_thread_id" VARCHAR(191),
  "rfc_message_id" VARCHAR(998),
  "reason" VARCHAR(40) NOT NULL,
  "candidate_count" INTEGER NOT NULL DEFAULT 0,
  "sender_hash" CHAR(64),
  "body_sha256" CHAR(64),
  "body_bytes" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "received_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "resolved_by" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_inbound_quarantines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_inbound_quarantines_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED')),
  CONSTRAINT "client_inbound_quarantines_reason_check" CHECK ("reason" IN (
    'UNKNOWN_THREAD', 'AMBIGUOUS_THREAD', 'SENDER_MISMATCH', 'OVERSIZED_MESSAGE',
    'INVALID_MESSAGE'
  )),
  CONSTRAINT "client_inbound_quarantines_resolution_check"
    CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL)),
  CONSTRAINT "client_inbound_quarantines_bytes_check" CHECK ("body_bytes" >= 0)
);

CREATE UNIQUE INDEX "client_inbound_quarantines_provider_message_key"
  ON "client_inbound_quarantines"("provider", "mailbox_id", "provider_message_id");
CREATE INDEX "client_inbound_quarantines_status_idx"
  ON "client_inbound_quarantines"("status", "received_at", "id");

COMMIT;
