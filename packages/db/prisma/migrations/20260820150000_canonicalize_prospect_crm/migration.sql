-- CRM canonicalization: provider namespaces, opportunity ownership, durable contactability,
-- multi-location conversion, immutable send snapshots, and transactional outbox.

ALTER TYPE "ProspectSendBatchStatus" ADD VALUE IF NOT EXISTS 'ATTENTION_REQUIRED';
ALTER TYPE "ProspectSendItemStatus" ADD VALUE IF NOT EXISTS 'PERMANENTLY_FAILED';
ALTER TYPE "ProspectSendItemStatus" ADD VALUE IF NOT EXISTS 'AMBIGUOUS';
ALTER TYPE "ProspectSendItemStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_IDENTITY_CHANGED';

CREATE TYPE "CorrespondenceProviderKey" AS ENUM ('GMAIL', 'RESEND', 'FAKE');
CREATE TYPE "CorrespondenceAccountStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'AUTH_FAILED', 'DISABLED');
CREATE TYPE "CorrespondenceCapability" AS ENUM ('SEND', 'RECEIVE', 'WATCH', 'RECONCILE');
CREATE TYPE "ProspectContactReadiness" AS ENUM ('UNKNOWN', 'UNVERIFIED', 'REVIEW_REQUIRED', 'VALID', 'INVALID');
CREATE TYPE "ProspectPermissionState" AS ENUM ('UNKNOWN', 'REVIEW_REQUIRED', 'LEGITIMATE_INTEREST_RECORDED', 'OPTED_IN', 'OPTED_OUT', 'PROHIBITED');
CREATE TYPE "ProspectSuppressionEventType" AS ENUM ('SUPPRESSED', 'UNSUBSCRIBED', 'HARD_BOUNCE', 'SOFT_BOUNCE', 'COMPLAINT', 'RESTORED');
CREATE TYPE "ProspectSuppressionSource" AS ENUM ('HUMAN', 'IMPORT', 'PROVIDER', 'INBOUND_MESSAGE', 'POLICY', 'SYSTEM');
CREATE TYPE "ProspectSendOutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'SUPPRESSED', 'CANCELLED', 'RETRYABLE', 'PERMANENTLY_FAILED', 'AMBIGUOUS');
CREATE TYPE "ProspectInboundReceiptStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'QUARANTINED', 'RETRYABLE', 'PERMANENTLY_FAILED');
CREATE TYPE "ProspectCustomerRelationshipStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'OFFBOARDED', 'SUPERSEDED');
CREATE TYPE "ProspectLocationConversionStatus" AS ENUM ('ACTIVE', 'REPLACED', 'OFFBOARDED');

CREATE TABLE "prospect_tags" (
  "id" TEXT NOT NULL,
  "label" VARCHAR(100) NOT NULL,
  "slug" VARCHAR(100) NOT NULL,
  "color" VARCHAR(32),
  "description" VARCHAR(1000),
  "archived_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prospect_organization_tags" (
  "organization_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  "added_by" VARCHAR(191) NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_organization_tags_pkey" PRIMARY KEY ("organization_id", "tag_id")
);

CREATE TABLE "correspondence_provider_accounts" (
  "id" TEXT NOT NULL,
  "provider" "CorrespondenceProviderKey" NOT NULL,
  "external_account_id" VARCHAR(191) NOT NULL,
  "mailbox_address" VARCHAR(320) NOT NULL,
  "display_name" VARCHAR(191),
  "capabilities" "CorrespondenceCapability"[] NOT NULL DEFAULT ARRAY[]::"CorrespondenceCapability"[],
  "connection_status" "CorrespondenceAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "credential_reference_id" VARCHAR(191),
  "sync_cursor" VARCHAR(512),
  "watch_expiration" TIMESTAMP(3),
  "last_successful_sync_at" TIMESTAMP(3),
  "last_reconciliation_at" TIMESTAMP(3),
  "last_health_check_at" TIMESTAMP(3),
  "health_error_code" VARCHAR(100),
  "health_error_summary" VARCHAR(2000),
  "daily_send_cap" INTEGER NOT NULL DEFAULT 10,
  "per_domain_daily_cap" INTEGER NOT NULL DEFAULT 2,
  "minimum_delay_seconds" INTEGER NOT NULL DEFAULT 180,
  "jitter_seconds" INTEGER NOT NULL DEFAULT 120,
  "delivery_enabled" BOOLEAN NOT NULL DEFAULT false,
  "paused_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "updated_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "correspondence_provider_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "correspondence_provider_accounts_safe_caps" CHECK ("daily_send_cap" BETWEEN 0 AND 500 AND "per_domain_daily_cap" BETWEEN 0 AND 100 AND "minimum_delay_seconds" >= 0 AND "jitter_seconds" >= 0)
);

CREATE TABLE "prospect_delivery_control" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "delivery_enabled" BOOLEAN NOT NULL DEFAULT false,
  "internal_only" BOOLEAN NOT NULL DEFAULT true,
  "internal_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "physical_contact_line" VARCHAR(500),
  "changed_by" VARCHAR(191) NOT NULL DEFAULT 'system',
  "changed_reason" VARCHAR(2000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_delivery_control_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_delivery_control_singleton" CHECK ("id" = 'global')
);

INSERT INTO "prospect_delivery_control" ("id", "updated_at") VALUES ('global', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "prospect_contacts"
  ADD COLUMN "email_readiness" "ProspectContactReadiness" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "permission_state" "ProspectPermissionState" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "permission_evidence" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "suppressed_at" TIMESTAMP(3),
  ADD COLUMN "unsubscribed_at" TIMESTAMP(3),
  ADD COLUMN "complained_at" TIMESTAMP(3),
  ADD COLUMN "last_hard_bounce_at" TIMESTAMP(3),
  ADD COLUMN "last_soft_bounce_at" TIMESTAMP(3);

UPDATE "prospect_contacts"
SET "email_readiness" = CASE WHEN "normalized_email" IS NULL THEN 'UNKNOWN'::"ProspectContactReadiness" ELSE 'UNVERIFIED'::"ProspectContactReadiness" END,
    "permission_state" = CASE WHEN "do_not_contact" THEN 'PROHIBITED'::"ProspectPermissionState" ELSE 'UNKNOWN'::"ProspectPermissionState" END,
    "suppressed_at" = CASE WHEN "do_not_contact" THEN COALESCE("updated_at", CURRENT_TIMESTAMP) ELSE NULL END;

CREATE TABLE "prospect_contact_suppression_events" (
  "id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "event_type" "ProspectSuppressionEventType" NOT NULL,
  "source" "ProspectSuppressionSource" NOT NULL,
  "reason_code" VARCHAR(100) NOT NULL,
  "reason" VARCHAR(2000),
  "provider" "CorrespondenceProviderKey",
  "actor_type" "ActorType" NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_contact_suppression_events_pkey" PRIMARY KEY ("id")
);

INSERT INTO "prospect_contact_suppression_events" ("id", "contact_id", "event_type", "source", "reason_code", "reason", "actor_type", "actor_id", "occurred_at")
SELECT 'legacy_suppression_' || "id", "id", 'SUPPRESSED', 'SYSTEM', 'LEGACY_DO_NOT_CONTACT', "suppression_reason", 'SYSTEM', 'crm-canonicalization-migration', COALESCE("updated_at", CURRENT_TIMESTAMP)
FROM "prospect_contacts" WHERE "do_not_contact" = true;

CREATE TABLE "prospect_customer_relationships" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "status" "ProspectCustomerRelationshipStatus" NOT NULL DEFAULT 'ACTIVE',
  "relationship_version" INTEGER NOT NULL DEFAULT 1,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "created_by" VARCHAR(191) NOT NULL,
  "ended_by" VARCHAR(191),
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_customer_relationships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prospect_location_conversions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "relationship_id" TEXT NOT NULL,
  "prospect_venue_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "idempotency_key" VARCHAR(191) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" "ProspectLocationConversionStatus" NOT NULL DEFAULT 'ACTIVE',
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "converted_by" VARCHAR(191) NOT NULL,
  "ended_by" VARCHAR(191),
  "converted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_location_conversions_pkey" PRIMARY KEY ("id")
);

INSERT INTO "prospect_customer_relationships" ("id", "organization_id", "tenant_id", "idempotency_key", "evidence", "created_by", "started_at", "created_at", "updated_at")
SELECT "id" || '_relationship', "organization_id", "tenant_id", 'legacy-conversion:' || "id", "evidence", "actor_id", "converted_at", "converted_at", "converted_at"
FROM "prospect_conversions";

INSERT INTO "prospect_location_conversions" ("id", "tenant_id", "relationship_id", "prospect_venue_id", "venue_id", "idempotency_key", "evidence", "converted_by", "converted_at", "created_at", "updated_at")
SELECT "id" || '_location', "tenant_id", "id" || '_relationship', "prospect_venue_id", "venue_id", 'legacy-location-conversion:' || "id", "evidence", "actor_id", "converted_at", "converted_at", "converted_at"
FROM "prospect_conversions" WHERE "prospect_venue_id" IS NOT NULL AND "venue_id" IS NOT NULL;

ALTER TABLE "prospect_outreach_campaigns"
  ADD COLUMN "daily_send_cap" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "paused_at" TIMESTAMP(3);

ALTER TABLE "prospect_send_batches"
  ADD COLUMN "released_by" VARCHAR(191),
  ADD COLUMN "released_at" TIMESTAMP(3);

ALTER TABLE "prospect_send_items"
  ADD COLUMN "recipient_identity_hash" CHAR(64),
  ADD COLUMN "text_body_snapshot" TEXT,
  ADD COLUMN "html_body_snapshot" TEXT,
  ADD COLUMN "header_snapshot" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "provider_account_id" TEXT,
  ADD COLUMN "provider_operation_id" VARCHAR(191);

UPDATE "prospect_send_items" i
SET "recipient_identity_hash" = md5(lower(i."recipient_email_snapshot")) || md5(lower(i."recipient_email_snapshot")),
    "text_body_snapshot" = d."text_body",
    "html_body_snapshot" = d."html_body"
FROM "prospect_outreach_drafts" d WHERE d."id" = i."draft_id";

ALTER TABLE "prospect_send_items"
  ALTER COLUMN "recipient_identity_hash" SET NOT NULL,
  ALTER COLUMN "text_body_snapshot" SET NOT NULL;

CREATE TABLE "prospect_send_outbox" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "send_item_id" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "status" "ProspectSendOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claim_owner" VARCHAR(191),
  "claim_expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "provider_idempotency_key" VARCHAR(256) NOT NULL,
  "last_error_code" VARCHAR(100),
  "last_error_message" VARCHAR(2000),
  "last_error_retryable" BOOLEAN,
  "ambiguous_since" TIMESTAMP(3),
  "terminal_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_send_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prospect_email_thread_providers" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "provider_thread_id" VARCHAR(191) NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_email_thread_providers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "prospect_email_messages"
  ADD COLUMN "provider_account_id" TEXT,
  ADD COLUMN "references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cc_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bcc_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "prospect_email_events" ADD COLUMN "provider_account_id" TEXT;

ALTER TABLE "prospect_email_webhook_receipts"
  ADD COLUMN "provider_account_id" TEXT,
  ADD COLUMN "status" "ProspectInboundReceiptStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "quarantine_reason" VARCHAR(2000);

-- Preserve only rows with actual provider identities as disabled legacy Resend-shaped data.
INSERT INTO "correspondence_provider_accounts" ("id", "provider", "external_account_id", "mailbox_address", "connection_status", "created_by", "updated_by", "updated_at")
SELECT 'legacy-resend-account', 'RESEND', 'legacy-resend', 'legacy-resend-unconfigured@invalid', 'DISABLED', 'crm-canonicalization-migration', 'crm-canonicalization-migration', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "prospect_send_items" WHERE "provider_message_id" IS NOT NULL)
   OR EXISTS (SELECT 1 FROM "prospect_email_messages" WHERE "provider_message_id" IS NOT NULL)
   OR EXISTS (SELECT 1 FROM "prospect_email_events" WHERE "provider_event_id" IS NOT NULL)
   OR EXISTS (SELECT 1 FROM "prospect_email_webhook_receipts" WHERE lower("provider") = 'resend');

UPDATE "prospect_send_items" SET "provider_account_id" = 'legacy-resend-account' WHERE "provider_message_id" IS NOT NULL;
UPDATE "prospect_email_messages" SET "provider_account_id" = 'legacy-resend-account' WHERE "provider_message_id" IS NOT NULL;
UPDATE "prospect_email_events" SET "provider_account_id" = 'legacy-resend-account' WHERE "provider_event_id" IS NOT NULL;
UPDATE "prospect_email_webhook_receipts" SET "provider_account_id" = 'legacy-resend-account' WHERE lower("provider") = 'resend';

-- Normalize legacy JSON tags without treating the old JSON column as writable truth.
INSERT INTO "prospect_tags" ("id", "label", "slug", "created_by", "updated_by", "updated_at")
SELECT DISTINCT 'legacy_tag_' || md5(tag.label), tag.label, 'legacy-' || md5(tag.label), 'crm-canonicalization-migration', 'crm-canonicalization-migration', CURRENT_TIMESTAMP
FROM "prospect_organizations" o
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(o."tags") = 'array' THEN o."tags" ELSE '[]'::jsonb END) AS tag(label)
WHERE btrim(tag.label) <> '';

INSERT INTO "prospect_organization_tags" ("organization_id", "tag_id", "added_by")
SELECT DISTINCT o."id", 'legacy_tag_' || md5(tag.label), 'crm-canonicalization-migration'
FROM "prospect_organizations" o
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(o."tags") = 'array' THEN o."tags" ELSE '[]'::jsonb END) AS tag(label)
WHERE btrim(tag.label) <> '';

-- Opportunity owns current workflow state; compatibility projections are synchronized once, then guarded.
UPDATE "prospect_organizations" o
SET "owner_id" = p."owner_id", "priority" = p."priority", "updated_at" = CURRENT_TIMESTAMP
FROM "prospect_opportunities" p WHERE p."organization_id" = o."id";

UPDATE "prospect_venues" v
SET "stage" = p."stage", "priority" = p."priority", "next_action" = p."next_action", "next_action_at" = p."next_action_at", "updated_at" = CURRENT_TIMESTAMP
FROM "prospect_opportunities" p WHERE p."organization_id" = v."organization_id";

CREATE OR REPLACE FUNCTION reject_prospect_workflow_projection_update() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'prospect_organizations' THEN
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.priority IS DISTINCT FROM OLD.priority THEN
      RAISE EXCEPTION 'ProspectOpportunity owns owner and priority';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'prospect_venues' THEN
    IF NEW.stage IS DISTINCT FROM OLD.stage OR NEW.priority IS DISTINCT FROM OLD.priority OR NEW.next_action IS DISTINCT FROM OLD.next_action OR NEW.next_action_at IS DISTINCT FROM OLD.next_action_at THEN
      RAISE EXCEPTION 'ProspectOpportunity owns workflow state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prospect_organizations_workflow_projection_guard BEFORE UPDATE ON "prospect_organizations" FOR EACH ROW EXECUTE FUNCTION reject_prospect_workflow_projection_update();
CREATE TRIGGER prospect_venues_workflow_projection_guard BEFORE UPDATE ON "prospect_venues" FOR EACH ROW EXECUTE FUNCTION reject_prospect_workflow_projection_update();

DROP INDEX IF EXISTS "prospect_send_items_provider_message_id_key";
DROP INDEX IF EXISTS "prospect_email_messages_provider_message_id_key";
DROP INDEX IF EXISTS "prospect_email_events_provider_event_id_key";
DROP INDEX IF EXISTS "prospect_email_webhook_receipts_provider_provider_event_id_key";

CREATE UNIQUE INDEX "prospect_tags_slug_key" ON "prospect_tags"("slug");
CREATE INDEX "prospect_tags_archived_at_label_idx" ON "prospect_tags"("archived_at", "label");
CREATE INDEX "prospect_organization_tags_tag_id_added_at_idx" ON "prospect_organization_tags"("tag_id", "added_at");
CREATE UNIQUE INDEX "correspondence_provider_accounts_provider_external_account_id_key" ON "correspondence_provider_accounts"("provider", "external_account_id");
CREATE UNIQUE INDEX "correspondence_provider_accounts_provider_mailbox_address_key" ON "correspondence_provider_accounts"("provider", "mailbox_address");
CREATE INDEX "correspondence_provider_accounts_provider_connection_status_updated_at_idx" ON "correspondence_provider_accounts"("provider", "connection_status", "updated_at");
CREATE INDEX "prospect_contact_suppression_events_contact_id_occurred_at_id_idx" ON "prospect_contact_suppression_events"("contact_id", "occurred_at", "id");
CREATE INDEX "prospect_contact_suppression_events_event_type_occurred_at_idx" ON "prospect_contact_suppression_events"("event_type", "occurred_at");
CREATE UNIQUE INDEX "prospect_customer_relationships_idempotency_key_key" ON "prospect_customer_relationships"("idempotency_key");
CREATE UNIQUE INDEX "prospect_customer_relationship_version_key" ON "prospect_customer_relationships"("organization_id", "tenant_id", "relationship_version");
CREATE INDEX "prospect_customer_relationships_organization_id_status_started_at_idx" ON "prospect_customer_relationships"("organization_id", "status", "started_at");
CREATE INDEX "prospect_customer_relationships_tenant_id_status_started_at_idx" ON "prospect_customer_relationships"("tenant_id", "status", "started_at");
CREATE UNIQUE INDEX "prospect_location_conversions_idempotency_key_key" ON "prospect_location_conversions"("idempotency_key");
CREATE UNIQUE INDEX "prospect_location_conversion_generation_key" ON "prospect_location_conversions"("relationship_id", "prospect_venue_id", "venue_id", "generation");
CREATE INDEX "prospect_location_conversions_prospect_venue_id_status_converted_at_idx" ON "prospect_location_conversions"("prospect_venue_id", "status", "converted_at");
CREATE INDEX "prospect_location_conversions_venue_id_status_converted_at_idx" ON "prospect_location_conversions"("venue_id", "status", "converted_at");
CREATE INDEX "prospect_location_conversions_tenant_id_status_converted_at_idx" ON "prospect_location_conversions"("tenant_id", "status", "converted_at");
CREATE UNIQUE INDEX "prospect_send_items_provider_operation_key" ON "prospect_send_items"("provider_account_id", "provider_operation_id");
CREATE UNIQUE INDEX "prospect_send_items_provider_message_key" ON "prospect_send_items"("provider_account_id", "provider_message_id");
CREATE UNIQUE INDEX "prospect_send_outbox_operation_id_key" ON "prospect_send_outbox"("operation_id");
CREATE UNIQUE INDEX "prospect_send_outbox_send_item_id_key" ON "prospect_send_outbox"("send_item_id");
CREATE UNIQUE INDEX "prospect_send_outbox_provider_idempotency_key" ON "prospect_send_outbox"("provider_account_id", "provider_idempotency_key");
CREATE INDEX "prospect_send_outbox_status_available_at_claim_expires_at_idx" ON "prospect_send_outbox"("status", "available_at", "claim_expires_at");
CREATE UNIQUE INDEX "prospect_email_thread_provider_key" ON "prospect_email_thread_providers"("provider_account_id", "provider_thread_id");
CREATE UNIQUE INDEX "prospect_email_thread_account_key" ON "prospect_email_thread_providers"("thread_id", "provider_account_id");
CREATE UNIQUE INDEX "prospect_email_messages_provider_message_key" ON "prospect_email_messages"("provider_account_id", "provider_message_id");
CREATE UNIQUE INDEX "prospect_email_events_provider_event_key" ON "prospect_email_events"("provider_account_id", "provider_event_id");
CREATE UNIQUE INDEX "prospect_email_receipts_provider_account_event_key" ON "prospect_email_webhook_receipts"("provider", "provider_account_id", "provider_event_id");

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "prospect_org_name_trgm_idx" ON "prospect_organizations" USING GIN ("canonical_name" gin_trgm_ops);
CREATE INDEX "prospect_org_domain_trgm_idx" ON "prospect_organizations" USING GIN ("normalized_domain" gin_trgm_ops);
CREATE INDEX "prospect_venue_name_trgm_idx" ON "prospect_venues" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "prospect_contact_email_trgm_idx" ON "prospect_contacts" USING GIN ("normalized_email" gin_trgm_ops);
CREATE UNIQUE INDEX "prospect_organizations_updated_at_id_key" ON "prospect_organizations"("updated_at", "id");

ALTER TABLE "prospect_organization_tags" ADD CONSTRAINT "prospect_organization_tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_organization_tags" ADD CONSTRAINT "prospect_organization_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "prospect_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_contact_suppression_events" ADD CONSTRAINT "prospect_contact_suppression_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_customer_relationships" ADD CONSTRAINT "prospect_customer_relationships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_customer_relationships" ADD CONSTRAINT "prospect_customer_relationships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_location_conversions" ADD CONSTRAINT "prospect_location_conversions_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "prospect_customer_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_location_conversions" ADD CONSTRAINT "prospect_location_conversions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_location_conversions" ADD CONSTRAINT "prospect_location_conversions_prospect_venue_id_fkey" FOREIGN KEY ("prospect_venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_location_conversions" ADD CONSTRAINT "prospect_location_conversions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_send_items" ADD CONSTRAINT "prospect_send_items_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_send_outbox" ADD CONSTRAINT "prospect_send_outbox_send_item_id_fkey" FOREIGN KEY ("send_item_id") REFERENCES "prospect_send_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_send_outbox" ADD CONSTRAINT "prospect_send_outbox_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_email_thread_providers" ADD CONSTRAINT "prospect_email_thread_providers_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "prospect_email_threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_email_thread_providers" ADD CONSTRAINT "prospect_email_thread_providers_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_email_messages" ADD CONSTRAINT "prospect_email_messages_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_email_events" ADD CONSTRAINT "prospect_email_events_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_email_webhook_receipts" ADD CONSTRAINT "prospect_email_webhook_receipts_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
