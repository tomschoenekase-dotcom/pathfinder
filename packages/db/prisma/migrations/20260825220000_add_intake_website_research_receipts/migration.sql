BEGIN;

CREATE TYPE "IntakeWebsiteResearchOutcome" AS ENUM ('SUCCEEDED', 'INACCESSIBLE', 'FAILED');
ALTER TYPE "IntakeEventKind" ADD VALUE 'WEBSITE_RESEARCH_RECORDED';

CREATE TABLE "intake_website_research_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "prior_receipt_id" UUID,
  "request_hash" CHAR(64) NOT NULL,
  "outcome" "IntakeWebsiteResearchOutcome" NOT NULL,
  "source_uri_hash" CHAR(64) NOT NULL,
  "bounds" JSONB NOT NULL,
  "research_snapshot" JSONB,
  "candidate_snapshot" JSONB,
  "attempted_fetches" INTEGER NOT NULL DEFAULT 0,
  "fetched_pages" INTEGER NOT NULL DEFAULT 0,
  "fetched_bytes" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost_units" INTEGER NOT NULL DEFAULT 0,
  "latency_ms" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(64),
  "error_message" VARCHAR(500),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_website_research_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_website_research_receipts_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "intake_website_research_receipts_source_uri_hash_check" CHECK ("source_uri_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "intake_website_research_receipts_nonnegative_check" CHECK (
    "attempted_fetches" >= 0 AND "fetched_pages" >= 0 AND "fetched_bytes" >= 0 AND
    "estimated_cost_units" >= 0 AND "latency_ms" >= 0
  ),
  CONSTRAINT "intake_website_research_receipts_terminal_shape_check" CHECK (
    ("outcome" = 'SUCCEEDED' AND "research_snapshot" IS NOT NULL AND "error_code" IS NULL AND "error_message" IS NULL) OR
    ("outcome" IN ('INACCESSIBLE', 'FAILED') AND "research_snapshot" IS NULL AND "candidate_snapshot" IS NULL AND "error_code" IS NOT NULL AND "error_message" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "intake_website_research_receipts_scope_key" ON "intake_website_research_receipts"("id", "tenant_id", "venue_id");
CREATE INDEX "intake_website_research_receipts_run_created_idx" ON "intake_website_research_receipts"("tenant_id", "venue_id", "run_id", "created_at");

ALTER TABLE "intake_website_research_receipts" ADD CONSTRAINT "intake_website_research_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_website_research_receipts" ADD CONSTRAINT "intake_website_research_receipts_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_website_research_receipts" ADD CONSTRAINT "intake_website_research_receipts_run_scope_fkey" FOREIGN KEY ("run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "intake_website_research_receipts" ADD CONSTRAINT "intake_website_research_receipts_prior_scope_fkey" FOREIGN KEY ("prior_receipt_id", "tenant_id", "venue_id") REFERENCES "intake_website_research_receipts"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_intake_website_research_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER intake_website_research_receipts_append_only BEFORE UPDATE OR DELETE ON "intake_website_research_receipts" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_website_research_receipt_mutation();
CREATE TRIGGER intake_website_research_receipts_no_truncate BEFORE TRUNCATE ON "intake_website_research_receipts" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_website_research_receipt_mutation();

COMMIT;
