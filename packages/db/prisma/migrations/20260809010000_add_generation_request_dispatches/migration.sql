BEGIN;

CREATE TYPE "GenerationRequestKind" AS ENUM ('ANSWER_ANALYSIS', 'WEEKLY_REPORT');
CREATE TYPE "GenerationDispatchStatus" AS ENUM ('PENDING', 'CONSUMED');

ALTER TABLE "answer_analysis_snapshots" ADD COLUMN "recovery_lineage_token" UUID;
ALTER TABLE "weekly_reports" ADD COLUMN "recovery_lineage_token" UUID;

CREATE UNIQUE INDEX "answer_analysis_snapshots_id_tenant_id_venue_id_key"
  ON "answer_analysis_snapshots"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "weekly_reports_id_tenant_id_venue_id_key"
  ON "weekly_reports"("id", "tenant_id", "venue_id");

CREATE TABLE "generation_request_dispatches" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "kind" "GenerationRequestKind" NOT NULL,
  "request_id" UUID,
  "request_hash" TEXT,
  "record_id" TEXT NOT NULL,
  "range_start" TIMESTAMP(3) NOT NULL,
  "range_end" TIMESTAMP(3) NOT NULL,
  "status" "GenerationDispatchStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "last_error" TEXT,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answer_analysis_snapshot_id" TEXT,
  "weekly_report_id" TEXT,
  CONSTRAINT "generation_request_dispatches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generation_request_dispatches_request_pair_check" CHECK (
    ("request_id" IS NULL AND "request_hash" IS NULL) OR
    ("request_id" IS NOT NULL AND "request_hash" IS NOT NULL AND "request_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "generation_request_dispatches_lease_pair_check" CHECK (
    ("lease_token" IS NULL) = ("lease_expires_at" IS NULL)
  ),
  CONSTRAINT "generation_request_dispatches_error_length_check" CHECK (
    "last_error" IS NULL OR char_length("last_error") <= 1000
  ),
  CONSTRAINT "generation_request_dispatches_target_check" CHECK (
    ("kind" = 'ANSWER_ANALYSIS' AND "answer_analysis_snapshot_id" IS NOT NULL AND "weekly_report_id" IS NULL AND "record_id" = "answer_analysis_snapshot_id") OR
    ("kind" = 'WEEKLY_REPORT' AND "weekly_report_id" IS NOT NULL AND "answer_analysis_snapshot_id" IS NULL AND "record_id" = "weekly_report_id")
  ),
  CONSTRAINT "generation_request_dispatches_state_check" CHECK (
    ("status" = 'PENDING' AND "consumed_at" IS NULL) OR
    ("status" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "generation_request_dispatches_answer_analysis_snapshot_id_key" ON "generation_request_dispatches"("answer_analysis_snapshot_id");
CREATE UNIQUE INDEX "generation_request_dispatches_weekly_report_id_key" ON "generation_request_dispatches"("weekly_report_id");
CREATE UNIQUE INDEX "generation_request_dispatches_tenant_id_kind_request_id_key" ON "generation_request_dispatches"("tenant_id", "kind", "request_id");
CREATE UNIQUE INDEX "generation_request_dispatches_tenant_id_kind_record_id_key" ON "generation_request_dispatches"("tenant_id", "kind", "record_id");
CREATE UNIQUE INDEX "generation_request_dispatches_answer_analysis_snapshot_scope_key" ON "generation_request_dispatches"("answer_analysis_snapshot_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "generation_request_dispatches_weekly_report_scope_key" ON "generation_request_dispatches"("weekly_report_id", "tenant_id", "venue_id");
CREATE INDEX "generation_request_dispatches_due_idx" ON "generation_request_dispatches"("status", "next_attempt_at", "lease_expires_at", "created_at");
CREATE INDEX "generation_request_dispatches_tenant_audit_idx" ON "generation_request_dispatches"("tenant_id", "venue_id", "created_at");

ALTER TABLE "generation_request_dispatches" ADD CONSTRAINT "generation_request_dispatches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generation_request_dispatches" ADD CONSTRAINT "generation_request_dispatches_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generation_request_dispatches" ADD CONSTRAINT "generation_request_dispatches_answer_analysis_scope_fkey" FOREIGN KEY ("answer_analysis_snapshot_id", "tenant_id", "venue_id") REFERENCES "answer_analysis_snapshots"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "generation_request_dispatches" ADD CONSTRAINT "generation_request_dispatches_weekly_report_scope_fkey" FOREIGN KEY ("weekly_report_id", "tenant_id", "venue_id") REFERENCES "weekly_reports"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "generation_request_dispatches" ("id", "tenant_id", "venue_id", "kind", "record_id", "range_start", "range_end", "answer_analysis_snapshot_id", "created_at", "updated_at")
SELECT 'legacy-aa-' || md5(s."id"), s."tenant_id", s."venue_id", 'ANSWER_ANALYSIS', s."id", s."range_start", s."range_end", s."id", clock_timestamp(), clock_timestamp()
FROM "answer_analysis_snapshots" s
WHERE s."status" = 'GENERATING' AND s."execution_lease_token" IS NULL AND s."execution_lease_expires_at" IS NULL
ON CONFLICT ("tenant_id", "kind", "record_id") DO NOTHING;

INSERT INTO "generation_request_dispatches" ("id", "tenant_id", "venue_id", "kind", "record_id", "range_start", "range_end", "weekly_report_id", "created_at", "updated_at")
SELECT 'legacy-wr-' || md5(r."id"), r."tenant_id", r."venue_id", 'WEEKLY_REPORT', r."id", r."week_start", r."week_end", r."id", clock_timestamp(), clock_timestamp()
FROM "weekly_reports" r
WHERE r."status" = 'GENERATING' AND r."execution_lease_token" IS NULL AND r."execution_lease_expires_at" IS NULL
ON CONFLICT ("tenant_id", "kind", "record_id") DO NOTHING;

COMMIT;
