CREATE TYPE "CharacterCandidateSourceProvenance" AS ENUM ('GENERATED', 'IMPORTED', 'IMPORTED_FIXTURE');
CREATE TYPE "CharacterCandidateReviewDecisionKind" AS ENUM ('ACCEPT', 'REJECT', 'REVISE');

CREATE TABLE "character_candidate_review_briefs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "custom_character_id" TEXT NOT NULL,
  "candidate_version" INTEGER NOT NULL,
  "candidate_revision" INTEGER NOT NULL,
  "artifact_fingerprint" CHAR(64) NOT NULL,
  "brief" VARCHAR(4000) NOT NULL,
  "rationale" VARCHAR(2000) NOT NULL,
  "source_provenance" "CharacterCandidateSourceProvenance" NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_candidate_review_briefs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "character_candidate_review_decisions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "brief_id" TEXT NOT NULL,
  "custom_character_id" TEXT NOT NULL,
  "candidate_version" INTEGER NOT NULL,
  "candidate_revision" INTEGER NOT NULL,
  "artifact_fingerprint" CHAR(64) NOT NULL,
  "operation_id" VARCHAR(191) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "decision" "CharacterCandidateReviewDecisionKind" NOT NULL,
  "revision_request" VARCHAR(2000),
  "resulting_job_id" TEXT,
  "decided_by" VARCHAR(191) NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "character_candidate_review_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "character_candidate_review_briefs_id_tenant_id_venue_id_key"
  ON "character_candidate_review_briefs"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "character_candidate_review_briefs_snapshot_key"
  ON "character_candidate_review_briefs"("tenant_id", "venue_id", "custom_character_id", "candidate_version", "candidate_revision", "artifact_fingerprint");
CREATE INDEX "character_candidate_review_briefs_scope_created_idx"
  ON "character_candidate_review_briefs"("tenant_id", "venue_id", "created_at");
CREATE UNIQUE INDEX "character_candidate_review_decisions_brief_id_key"
  ON "character_candidate_review_decisions"("brief_id");
CREATE UNIQUE INDEX "character_candidate_review_decisions_resulting_job_id_key"
  ON "character_candidate_review_decisions"("resulting_job_id");
CREATE UNIQUE INDEX "character_candidate_review_decisions_job_scope_key"
  ON "character_candidate_review_decisions"("resulting_job_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "character_factory_jobs_id_tenant_id_venue_id_key"
  ON "character_factory_jobs"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "character_candidate_review_decisions_tenant_operation_key"
  ON "character_candidate_review_decisions"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "character_candidate_review_decisions_brief_scope_key"
  ON "character_candidate_review_decisions"("brief_id", "tenant_id", "venue_id");
CREATE INDEX "character_candidate_review_decisions_scope_candidate_idx"
  ON "character_candidate_review_decisions"("tenant_id", "venue_id", "custom_character_id", "decided_at");

ALTER TABLE "character_candidate_review_briefs"
  ADD CONSTRAINT "character_candidate_review_briefs_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_briefs"
  ADD CONSTRAINT "character_candidate_review_briefs_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_briefs"
  ADD CONSTRAINT "character_candidate_review_briefs_character_fkey"
  FOREIGN KEY ("custom_character_id", "tenant_id", "venue_id") REFERENCES "custom_characters"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_decisions"
  ADD CONSTRAINT "character_candidate_review_decisions_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_decisions"
  ADD CONSTRAINT "character_candidate_review_decisions_venue_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_decisions"
  ADD CONSTRAINT "character_candidate_review_decisions_character_fkey"
  FOREIGN KEY ("custom_character_id", "tenant_id", "venue_id") REFERENCES "custom_characters"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_decisions"
  ADD CONSTRAINT "character_candidate_review_decisions_brief_fkey"
  FOREIGN KEY ("brief_id", "tenant_id", "venue_id") REFERENCES "character_candidate_review_briefs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "character_candidate_review_decisions"
  ADD CONSTRAINT "character_candidate_review_decisions_job_fkey"
  FOREIGN KEY ("resulting_job_id", "tenant_id", "venue_id") REFERENCES "character_factory_jobs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
