-- CreateEnum
CREATE TYPE "ProspectStage" AS ENUM ('DISCOVERED', 'RESEARCHED', 'NEEDS_REVIEW', 'READY_FOR_OUTREACH', 'CONTACTED', 'FOLLOW_UP_DUE', 'REPLIED', 'CONVERSATION', 'QUALIFIED', 'PROPOSAL_DECISION', 'WON', 'LOST', 'PARKED', 'DO_NOT_CONTACT');

-- CreateEnum
CREATE TYPE "ProspectPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ProspectActivityType" AS ENUM ('DISCOVERED', 'IMPORTED', 'RESEARCH_ADDED', 'STAGE_CHANGED', 'CONTACT_ADDED', 'NOTE_ADDED', 'OUTREACH_DRAFTED', 'OUTREACH_SENT', 'REPLY_RECEIVED', 'MEETING_OCCURRED', 'AI_RESEARCH_COMPLETED', 'CONVERTED_TO_CUSTOMER', 'ARCHIVED', 'RESTORED');

-- CreateEnum
CREATE TYPE "ProspectDuplicateStatus" AS ENUM ('OPEN', 'CONFIRMED_DUPLICATE', 'CONFIRMED_DISTINCT', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ProspectImportStatus" AS ENUM ('DRAFT', 'DRY_RUN_READY', 'APPROVED', 'PROCESSING', 'COMPLETE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ProspectImportRowStatus" AS ENUM ('VALID', 'WARNING', 'DUPLICATE_REVIEW', 'IMPORTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "prospect_territories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "region" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_territories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_organizations" (
    "id" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "aliases" JSONB NOT NULL DEFAULT '[]',
    "website" TEXT,
    "normalized_domain" TEXT,
    "organization_type" TEXT,
    "description" TEXT,
    "headquarters_city" TEXT,
    "headquarters_region" TEXT,
    "headquarters_country" TEXT,
    "territory_id" TEXT,
    "source" TEXT,
    "research_provenance" JSONB NOT NULL DEFAULT '[]',
    "owner_id" TEXT,
    "priority" "ProspectPriority" NOT NULL DEFAULT 'NORMAL',
    "notes" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_venues" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "territory_id" TEXT,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "website" TEXT,
    "normalized_domain" TEXT,
    "venue_type" TEXT,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country" TEXT,
    "estimated_size" TEXT,
    "fit_attributes" JSONB NOT NULL DEFAULT '{}',
    "visitor_operations" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "research_sources" JSONB NOT NULL DEFAULT '[]',
    "stage" "ProspectStage" NOT NULL DEFAULT 'DISCOVERED',
    "priority" "ProspectPriority" NOT NULL DEFAULT 'NORMAL',
    "next_action" TEXT,
    "next_action_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "source_import_row_id" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_contacts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "fullName" TEXT,
    "title" TEXT,
    "email" TEXT,
    "normalized_email" TEXT,
    "phone" TEXT,
    "source" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '[]',
    "preferred_communication" TEXT,
    "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
    "suppression_reason" TEXT,
    "notes" TEXT,
    "source_import_row_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_opportunities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "stage" "ProspectStage" NOT NULL DEFAULT 'DISCOVERED',
    "owner_id" TEXT,
    "priority" "ProspectPriority" NOT NULL DEFAULT 'NORMAL',
    "next_action" TEXT,
    "next_action_at" TIMESTAMP(3),
    "lost_parked_reason" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "last_activity_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_stage_history" (
    "id" TEXT NOT NULL,
    "opportunity_id" TEXT NOT NULL,
    "from_stage" "ProspectStage",
    "to_stage" "ProspectStage" NOT NULL,
    "reason" TEXT,
    "actor_id" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_activities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "contact_id" TEXT,
    "type" "ProspectActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "actor_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_source_evidence" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "contact_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_url" TEXT,
    "source_label" TEXT,
    "captured_value" JSONB,
    "import_row_id" TEXT,
    "researched_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_source_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_duplicate_candidates" (
    "id" TEXT NOT NULL,
    "organization_a_id" TEXT NOT NULL,
    "organization_b_id" TEXT NOT NULL,
    "status" "ProspectDuplicateStatus" NOT NULL DEFAULT 'OPEN',
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "resolution_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_imports" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "file_hash" CHAR(64) NOT NULL,
    "mapping_hash" CHAR(64) NOT NULL,
    "import_identity_hash" CHAR(64) NOT NULL,
    "mapping" JSONB NOT NULL,
    "status" "ProspectImportStatus" NOT NULL DEFAULT 'DRAFT',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "warning_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_import_sheets" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "sheet_name" TEXT NOT NULL,
    "sheet_index" INTEGER NOT NULL,
    "detected_rows" INTEGER NOT NULL,
    "columns" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_import_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_import_rows" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "sheet_name" TEXT NOT NULL,
    "original_row_number" INTEGER NOT NULL,
    "row_fingerprint" CHAR(64) NOT NULL,
    "source_values" JSONB NOT NULL,
    "normalized_values" JSONB NOT NULL,
    "status" "ProspectImportRowStatus" NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "duplicate_matches" JSONB NOT NULL DEFAULT '[]',
    "imported_organization_id" TEXT,
    "imported_venue_id" TEXT,
    "imported_contact_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_conversions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "prospect_venue_id" TEXT,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "converted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prospect_territories_code_key" ON "prospect_territories"("code");

-- CreateIndex
CREATE INDEX "prospect_territories_archived_at_name_idx" ON "prospect_territories"("archived_at", "name");

-- CreateIndex
CREATE INDEX "prospect_organizations_normalized_name_idx" ON "prospect_organizations"("normalized_name");

-- CreateIndex
CREATE INDEX "prospect_organizations_normalized_domain_idx" ON "prospect_organizations"("normalized_domain");

-- CreateIndex
CREATE INDEX "prospect_organizations_territory_id_archived_at_idx" ON "prospect_organizations"("territory_id", "archived_at");

-- CreateIndex
CREATE INDEX "prospect_organizations_owner_id_archived_at_idx" ON "prospect_organizations"("owner_id", "archived_at");

-- CreateIndex
CREATE INDEX "prospect_venues_organization_id_archived_at_idx" ON "prospect_venues"("organization_id", "archived_at");

-- CreateIndex
CREATE INDEX "prospect_venues_normalized_name_idx" ON "prospect_venues"("normalized_name");

-- CreateIndex
CREATE INDEX "prospect_venues_normalized_domain_idx" ON "prospect_venues"("normalized_domain");

-- CreateIndex
CREATE INDEX "prospect_venues_territory_id_stage_priority_idx" ON "prospect_venues"("territory_id", "stage", "priority");

-- CreateIndex
CREATE INDEX "prospect_venues_next_action_at_archived_at_idx" ON "prospect_venues"("next_action_at", "archived_at");

-- CreateIndex
CREATE INDEX "prospect_contacts_organization_id_archived_at_idx" ON "prospect_contacts"("organization_id", "archived_at");

-- CreateIndex
CREATE INDEX "prospect_contacts_venue_id_archived_at_idx" ON "prospect_contacts"("venue_id", "archived_at");

-- CreateIndex
CREATE INDEX "prospect_contacts_normalized_email_idx" ON "prospect_contacts"("normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_opportunities_organization_id_key" ON "prospect_opportunities"("organization_id");

-- CreateIndex
CREATE INDEX "prospect_opportunities_stage_priority_next_action_at_idx" ON "prospect_opportunities"("stage", "priority", "next_action_at");

-- CreateIndex
CREATE INDEX "prospect_opportunities_owner_id_stage_idx" ON "prospect_opportunities"("owner_id", "stage");

-- CreateIndex
CREATE INDEX "prospect_stage_history_opportunity_id_created_at_idx" ON "prospect_stage_history"("opportunity_id", "created_at");

-- CreateIndex
CREATE INDEX "prospect_activities_organization_id_occurred_at_idx" ON "prospect_activities"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "prospect_activities_venue_id_occurred_at_idx" ON "prospect_activities"("venue_id", "occurred_at");

-- CreateIndex
CREATE INDEX "prospect_activities_contact_id_occurred_at_idx" ON "prospect_activities"("contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "prospect_source_evidence_organization_id_created_at_idx" ON "prospect_source_evidence"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "prospect_source_evidence_import_row_id_idx" ON "prospect_source_evidence"("import_row_id");

-- CreateIndex
CREATE INDEX "prospect_duplicate_candidates_status_confidence_idx" ON "prospect_duplicate_candidates"("status", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_duplicate_candidates_organization_a_id_organizatio_key" ON "prospect_duplicate_candidates"("organization_a_id", "organization_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_imports_import_identity_hash_key" ON "prospect_imports"("import_identity_hash");

-- CreateIndex
CREATE INDEX "prospect_imports_status_created_at_idx" ON "prospect_imports"("status", "created_at");

-- CreateIndex
CREATE INDEX "prospect_imports_file_hash_idx" ON "prospect_imports"("file_hash");

-- CreateIndex
CREATE INDEX "prospect_import_sheets_import_id_sheet_index_idx" ON "prospect_import_sheets"("import_id", "sheet_index");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_import_sheets_import_id_sheet_name_key" ON "prospect_import_sheets"("import_id", "sheet_name");

-- CreateIndex
CREATE INDEX "prospect_import_rows_import_id_status_original_row_number_idx" ON "prospect_import_rows"("import_id", "status", "original_row_number");

-- CreateIndex
CREATE INDEX "prospect_import_rows_row_fingerprint_idx" ON "prospect_import_rows"("row_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_import_rows_import_id_sheet_name_original_row_numb_key" ON "prospect_import_rows"("import_id", "sheet_name", "original_row_number");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_conversions_organization_id_key" ON "prospect_conversions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_conversions_prospect_venue_id_key" ON "prospect_conversions"("prospect_venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_conversions_tenant_id_key" ON "prospect_conversions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_conversions_venue_id_key" ON "prospect_conversions"("venue_id");

-- CreateIndex
CREATE INDEX "prospect_conversions_converted_at_idx" ON "prospect_conversions"("converted_at");

-- AddForeignKey
ALTER TABLE "prospect_organizations" ADD CONSTRAINT "prospect_organizations_territory_id_fkey" FOREIGN KEY ("territory_id") REFERENCES "prospect_territories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_venues" ADD CONSTRAINT "prospect_venues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_venues" ADD CONSTRAINT "prospect_venues_territory_id_fkey" FOREIGN KEY ("territory_id") REFERENCES "prospect_territories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_venues" ADD CONSTRAINT "prospect_venues_source_import_row_id_fkey" FOREIGN KEY ("source_import_row_id") REFERENCES "prospect_import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_contacts" ADD CONSTRAINT "prospect_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_contacts" ADD CONSTRAINT "prospect_contacts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_contacts" ADD CONSTRAINT "prospect_contacts_source_import_row_id_fkey" FOREIGN KEY ("source_import_row_id") REFERENCES "prospect_import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_stage_history" ADD CONSTRAINT "prospect_stage_history_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "prospect_opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_activities" ADD CONSTRAINT "prospect_activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_activities" ADD CONSTRAINT "prospect_activities_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_activities" ADD CONSTRAINT "prospect_activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_source_evidence" ADD CONSTRAINT "prospect_source_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_source_evidence" ADD CONSTRAINT "prospect_source_evidence_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_source_evidence" ADD CONSTRAINT "prospect_source_evidence_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "prospect_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_source_evidence" ADD CONSTRAINT "prospect_source_evidence_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "prospect_import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_duplicate_candidates" ADD CONSTRAINT "prospect_duplicate_candidates_organization_a_id_fkey" FOREIGN KEY ("organization_a_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_duplicate_candidates" ADD CONSTRAINT "prospect_duplicate_candidates_organization_b_id_fkey" FOREIGN KEY ("organization_b_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_import_sheets" ADD CONSTRAINT "prospect_import_sheets_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "prospect_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_import_rows" ADD CONSTRAINT "prospect_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "prospect_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_prospect_venue_id_fkey" FOREIGN KEY ("prospect_venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_conversions" ADD CONSTRAINT "prospect_conversions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
