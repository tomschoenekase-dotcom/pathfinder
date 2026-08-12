BEGIN;

CREATE TABLE "support_preview_feedback" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "support_message_id" TEXT NOT NULL,
  "venue_package_id" TEXT NOT NULL,
  "created_by_kind" "SupportParticipantKind" NOT NULL DEFAULT 'CLIENT',
  "created_by_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_preview_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_preview_feedback_client_author_check" CHECK ("created_by_kind" = 'CLIENT')
);

CREATE UNIQUE INDEX "support_preview_feedback_id_scope_key" ON "support_preview_feedback"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "support_preview_feedback_request_scope_key" ON "support_preview_feedback"("support_request_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "support_preview_feedback_message_scope_key" ON "support_preview_feedback"("support_message_id", "tenant_id", "venue_id", "support_request_id");
CREATE INDEX "support_preview_feedback_package_created_idx" ON "support_preview_feedback"("tenant_id", "venue_id", "venue_package_id", "created_at", "id");

ALTER TABLE "support_preview_feedback" ADD CONSTRAINT "support_preview_feedback_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_preview_feedback" ADD CONSTRAINT "support_preview_feedback_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_preview_feedback" ADD CONSTRAINT "support_preview_feedback_request_scope_fkey" FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_preview_feedback" ADD CONSTRAINT "support_preview_feedback_message_scope_fkey" FOREIGN KEY ("support_message_id", "tenant_id", "venue_id", "support_request_id") REFERENCES "support_messages"("id", "tenant_id", "venue_id", "support_request_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_preview_feedback" ADD CONSTRAINT "support_preview_feedback_package_scope_fkey" FOREIGN KEY ("venue_package_id", "tenant_id", "venue_id") REFERENCES "venue_packages"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_support_preview_feedback_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER support_preview_feedback_append_only BEFORE UPDATE OR DELETE ON "support_preview_feedback" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_support_preview_feedback_mutation();
CREATE TRIGGER support_preview_feedback_no_truncate BEFORE TRUNCATE ON "support_preview_feedback" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_support_preview_feedback_mutation();

COMMIT;
