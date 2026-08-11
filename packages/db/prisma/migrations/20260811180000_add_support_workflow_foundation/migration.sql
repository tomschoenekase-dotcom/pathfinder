BEGIN;

CREATE TYPE "SupportRequestStatus" AS ENUM (
  'OPEN', 'WAITING_FOR_CLIENT', 'IN_REVIEW', 'PATCH_DRAFTED', 'VALIDATING',
  'AWAITING_APPROVAL', 'APPLYING', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE "SupportRequestCategory" AS ENUM (
  'CONTENT_CORRECTION', 'OPERATIONAL_UPDATE', 'BRANDING',
  'EXPERIENCE_BEHAVIOR', 'ACCESSIBILITY', 'GENERAL'
);
CREATE TYPE "SupportParticipantKind" AS ENUM ('CLIENT', 'OPERATOR', 'AGENT', 'SYSTEM');
CREATE TYPE "SupportMessageVisibility" AS ENUM ('CLIENT_VISIBLE', 'INTERNAL_ONLY');

CREATE TABLE "support_requests" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "category" "SupportRequestCategory" NOT NULL,
  "status" "SupportRequestStatus" NOT NULL DEFAULT 'OPEN',
  "subject" VARCHAR(200) NOT NULL,
  "missing_information" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "artifacts" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_kind" "SupportParticipantKind" NOT NULL,
  "created_by_id" VARCHAR(191) NOT NULL,
  "updated_by_kind" "SupportParticipantKind" NOT NULL,
  "updated_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_requests_subject_check" CHECK (char_length(btrim("subject")) BETWEEN 1 AND 200),
  CONSTRAINT "support_requests_version_check" CHECK ("version" > 0),
  CONSTRAINT "support_requests_artifacts_object_check" CHECK (jsonb_typeof("artifacts") = 'object'),
  CONSTRAINT "support_requests_id_tenant_id_venue_id_key" UNIQUE ("id", "tenant_id", "venue_id")
);

CREATE TABLE "support_messages" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "author_kind" "SupportParticipantKind" NOT NULL,
  "author_id" VARCHAR(191) NOT NULL,
  "visibility" "SupportMessageVisibility" NOT NULL DEFAULT 'CLIENT_VISIBLE',
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_messages_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 20000),
  CONSTRAINT "support_messages_client_visibility_check" CHECK (
    "author_kind" <> 'CLIENT' OR "visibility" = 'CLIENT_VISIBLE'
  ),
  CONSTRAINT "support_messages_id_tenant_id_venue_id_request_id_key"
    UNIQUE ("id", "tenant_id", "venue_id", "support_request_id")
);

CREATE TABLE "support_message_attachments" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "support_message_id" TEXT NOT NULL,
  "filename" VARCHAR(255) NOT NULL,
  "media_type" VARCHAR(127) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "source_id" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_message_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_message_attachments_filename_check" CHECK (char_length(btrim("filename")) BETWEEN 1 AND 255),
  CONSTRAINT "support_message_attachments_media_type_check" CHECK (char_length(btrim("media_type")) BETWEEN 1 AND 127),
  CONSTRAINT "support_message_attachments_byte_size_check" CHECK ("byte_size" >= 0)
);

CREATE TABLE "support_request_audit_events" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "request_version" INTEGER NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "actor_kind" "SupportParticipantKind" NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "from_status" "SupportRequestStatus",
  "to_status" "SupportRequestStatus",
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_request_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_request_audit_events_version_check" CHECK ("request_version" > 0),
  CONSTRAINT "support_request_audit_events_event_type_check" CHECK (char_length(btrim("event_type")) BETWEEN 1 AND 100),
  CONSTRAINT "support_request_audit_events_status_pair_check" CHECK (
    ("from_status" IS NULL) = ("to_status" IS NULL)
  ),
  CONSTRAINT "support_request_audit_events_request_scope_version_key"
    UNIQUE ("support_request_id", "tenant_id", "venue_id", "request_version")
);

CREATE INDEX "support_requests_tenant_id_venue_id_updated_at_id_idx"
  ON "support_requests"("tenant_id", "venue_id", "updated_at", "id");
CREATE INDEX "support_requests_tenant_id_status_updated_at_idx"
  ON "support_requests"("tenant_id", "status", "updated_at");
CREATE INDEX "support_messages_tenant_id_venue_id_request_created_id_idx"
  ON "support_messages"("tenant_id", "venue_id", "support_request_id", "created_at", "id");
CREATE INDEX "support_message_attachments_scope_idx"
  ON "support_message_attachments"("tenant_id", "venue_id", "support_request_id", "support_message_id");
CREATE INDEX "support_request_audit_events_scope_version_idx"
  ON "support_request_audit_events"("tenant_id", "venue_id", "support_request_id", "request_version");

ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_request_scope_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")
  REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "support_message_attachments" ADD CONSTRAINT "support_message_attachments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_message_attachments" ADD CONSTRAINT "support_message_attachments_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_message_attachments" ADD CONSTRAINT "support_message_attachments_message_scope_fkey"
  FOREIGN KEY ("support_message_id", "tenant_id", "venue_id", "support_request_id")
  REFERENCES "support_messages"("id", "tenant_id", "venue_id", "support_request_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "support_request_audit_events" ADD CONSTRAINT "support_request_audit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_request_audit_events" ADD CONSTRAINT "support_request_audit_events_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_request_audit_events" ADD CONSTRAINT "support_request_audit_events_request_scope_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")
  REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_support_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER support_messages_append_only
  BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_evidence_mutation();
CREATE TRIGGER support_messages_no_truncate
  BEFORE TRUNCATE ON "support_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_evidence_mutation();
CREATE TRIGGER support_message_attachments_append_only
  BEFORE UPDATE OR DELETE ON "support_message_attachments"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_evidence_mutation();
CREATE TRIGGER support_message_attachments_no_truncate
  BEFORE TRUNCATE ON "support_message_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_evidence_mutation();
CREATE TRIGGER support_request_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "support_request_audit_events"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_evidence_mutation();
CREATE TRIGGER support_request_audit_events_no_truncate
  BEFORE TRUNCATE ON "support_request_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_evidence_mutation();

COMMIT;
