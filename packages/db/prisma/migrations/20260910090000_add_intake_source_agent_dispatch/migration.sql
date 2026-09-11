CREATE TABLE "intake_source_agent_dispatches" (
 "id" UUID NOT NULL, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
 "extraction_dispatch_id" TEXT NOT NULL, "intake_run_id" TEXT NOT NULL,
 "receipt_id" UUID NOT NULL, "extracted_text_hash" CHAR(64) NOT NULL,
 "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING', "hold_reason" VARCHAR(64),
 "policy_revision" INTEGER, "agent_identity_id" TEXT, "agent_run_id" TEXT,
 "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "intake_source_agent_dispatches_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "intake_source_agent_dispatch_status_check" CHECK ("status" IN ('PENDING','HELD','COMPLETED','CANCELLED')),
 CONSTRAINT "intake_source_agent_dispatch_completion_check" CHECK (("status" = 'COMPLETED') = ("agent_run_id" IS NOT NULL AND "agent_identity_id" IS NOT NULL AND "policy_revision" IS NOT NULL)),
 CONSTRAINT "intake_source_agent_dispatch_revision_check" CHECK ("policy_revision" IS NULL OR "policy_revision" > 0),
 CONSTRAINT "intake_source_agent_dispatch_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "intake_source_agent_dispatch_venue_fkey" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "intake_source_agent_dispatch_extraction_fkey" FOREIGN KEY ("extraction_dispatch_id","tenant_id","venue_id") REFERENCES "intake_v1_processing_dispatches"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "intake_source_agent_dispatch_receipt_fkey" FOREIGN KEY ("receipt_id","tenant_id","venue_id","intake_run_id") REFERENCES "intake_file_extraction_receipts"("id","tenant_id","venue_id","run_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "intake_source_agent_dispatch_run_fkey" FOREIGN KEY ("agent_run_id","tenant_id","venue_id") REFERENCES "agent_runs"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "intake_source_agent_dispatch_extraction_key" ON "intake_source_agent_dispatches"("extraction_dispatch_id");
CREATE UNIQUE INDEX "intake_source_agent_dispatch_scope_key" ON "intake_source_agent_dispatches"("id","tenant_id","venue_id");
CREATE INDEX "intake_source_agent_dispatch_ready_idx" ON "intake_source_agent_dispatches"("status","next_attempt_at","id");
