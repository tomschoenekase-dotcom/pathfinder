CREATE TYPE "IntakeSubmissionDraftSourceKind" AS ENUM ('WEBSITE', 'INTERVIEW', 'NOTES');

CREATE TABLE "intake_submission_drafts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "source_kind" "IntakeSubmissionDraftSourceKind" NOT NULL,
  "content" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "submitted_proposal_id" TEXT,
  "submitted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intake_submission_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_submission_drafts_scope_key" UNIQUE ("tenant_id", "venue_id", "owner_user_id", "source_kind"),
  CONSTRAINT "intake_submission_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_submission_drafts_venue_id_tenant_id_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_submission_drafts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "intake_submission_drafts_resume_idx" ON "intake_submission_drafts"("tenant_id", "venue_id", "owner_user_id", "updated_at");
