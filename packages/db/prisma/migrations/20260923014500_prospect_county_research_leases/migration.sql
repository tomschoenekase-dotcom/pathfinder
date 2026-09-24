-- Native, globally exclusive whole-county work scope. No existing business rows
-- are rewritten. Old county/model definitions and import lineage remain intact.
CREATE TABLE "prospect_county_research_leases" (
  "model_version" VARCHAR(100) NOT NULL,
  "county_geoid" CHAR(5) NOT NULL,
  "territory_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(32) NOT NULL,
  "claim_token" UUID NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "actor_run_id" VARCHAR(191) NOT NULL,
  "authority_context" VARCHAR(400) NOT NULL,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "planned_cells" JSONB NOT NULL,
  "outcome" JSONB NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prospect_county_research_leases_pkey" PRIMARY KEY ("model_version", "county_geoid"),
  CONSTRAINT "prospect_county_research_lease_county_fkey" FOREIGN KEY ("model_version", "county_geoid", "territory_id")
    REFERENCES "prospect_county_assignments" ("model_version", "county_geoid", "territory_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_county_research_lease_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "prospect_county_research_lease_status_check" CHECK ("status" IN ('LEASED', 'RELEASED', 'ATTEMPT_RECORDED')),
  CONSTRAINT "prospect_county_research_lease_cells_check" CHECK (jsonb_typeof("planned_cells") = 'array' AND jsonb_array_length("planned_cells") BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX "prospect_county_research_leases_claim_token_key" ON "prospect_county_research_leases" ("claim_token");
CREATE UNIQUE INDEX "prospect_county_research_lease_identity_key" ON "prospect_county_research_leases" ("model_version", "county_geoid", "territory_id");
CREATE INDEX "prospect_county_research_lease_status_idx" ON "prospect_county_research_leases" ("territory_id", "status", "lease_expires_at");
