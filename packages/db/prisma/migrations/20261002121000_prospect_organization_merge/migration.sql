BEGIN;

ALTER TABLE "prospect_organizations"
  ADD COLUMN "merged_into_organization_id" TEXT,
  ADD COLUMN "merged_at" TIMESTAMP(3),
  ADD COLUMN "merged_by" TEXT;

ALTER TABLE "prospect_organizations"
  ADD CONSTRAINT "prospect_organizations_merged_into_organization_id_fkey"
  FOREIGN KEY ("merged_into_organization_id") REFERENCES "prospect_organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "prospect_organizations_merged_into_organization_id_idx"
  ON "prospect_organizations"("merged_into_organization_id");

CREATE TABLE "prospect_organization_merges" (
  "id" TEXT NOT NULL,
  "source_organization_id" TEXT NOT NULL,
  "target_organization_id" TEXT NOT NULL,
  "plan_hash" CHAR(64) NOT NULL,
  "source_snapshot" JSONB NOT NULL,
  "moved_counts" JSONB NOT NULL,
  "note" VARCHAR(2000) NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prospect_organization_merges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prospect_organization_merges_source_organization_id_key"
  ON "prospect_organization_merges"("source_organization_id");
CREATE INDEX "prospect_organization_merges_target_organization_id_created_at_idx"
  ON "prospect_organization_merges"("target_organization_id", "created_at");

ALTER TABLE "prospect_organization_merges"
  ADD CONSTRAINT "prospect_organization_merges_source_organization_id_fkey"
  FOREIGN KEY ("source_organization_id") REFERENCES "prospect_organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prospect_organization_merges"
  ADD CONSTRAINT "prospect_organization_merges_target_organization_id_fkey"
  FOREIGN KEY ("target_organization_id") REFERENCES "prospect_organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
