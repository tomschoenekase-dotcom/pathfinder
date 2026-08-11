BEGIN;

CREATE TYPE "OffboardingPlanStatus" AS ENUM (
  'REQUESTED', 'REVIEWED', 'REVOCATION_SCHEDULED', 'REVOKING',
  'EXPORT_READY', 'COMPLETED', 'CANCELLED'
);
CREATE TYPE "OffboardingRevocationTarget" AS ENUM (
  'GUEST_LINKS', 'WIDGETS', 'PARTNER_API_KEYS', 'MCP_CREDENTIALS',
  'BACKGROUND_JOBS', 'AGENT_IDENTITIES', 'CLIENT_ACCESS', 'OPERATOR_IMPERSONATION'
);
CREATE TYPE "OffboardingEvidenceOutcome" AS ENUM ('COMPLETE', 'FAILED', 'SKIPPED');
CREATE TYPE "OffboardingExportKind" AS ENUM (
  'APPROVED_CONTENT', 'CONTENT_HISTORY', 'VENUE_PACKAGES', 'CONFIGURATION', 'AUDIT_HISTORY'
);

CREATE TABLE "offboarding_plans" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "status" "OffboardingPlanStatus" NOT NULL DEFAULT 'REQUESTED',
  "revocation_targets" "OffboardingRevocationTarget"[] NOT NULL,
  "export_kinds" "OffboardingExportKind"[] NOT NULL DEFAULT ARRAY[]::"OffboardingExportKind"[],
  "effective_at" TIMESTAMP(3),
  "requested_by" VARCHAR(191) NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offboarding_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_plans_revocation_targets_check"
    CHECK (cardinality("revocation_targets") BETWEEN 1 AND 8),
  CONSTRAINT "offboarding_plans_id_tenant_id_key" UNIQUE ("id", "tenant_id")
);

CREATE TABLE "offboarding_venue_targets" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offboarding_venue_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_venue_targets_plan_tenant_venue_key"
    UNIQUE ("plan_id", "tenant_id", "venue_id")
);

CREATE TABLE "offboarding_revocation_evidence" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "target" "OffboardingRevocationTarget" NOT NULL,
  "outcome" "OffboardingEvidenceOutcome" NOT NULL,
  "evidence_reference" VARCHAR(500) NOT NULL,
  "error_code" VARCHAR(100),
  "recorded_by" VARCHAR(191) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offboarding_revocation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_revocation_evidence_reference_check"
    CHECK (char_length(btrim("evidence_reference")) BETWEEN 1 AND 500),
  CONSTRAINT "offboarding_revocation_evidence_error_check" CHECK (
    ("outcome" = 'FAILED' AND "error_code" IS NOT NULL) OR
    ("outcome" <> 'FAILED' AND "error_code" IS NULL)
  ),
  CONSTRAINT "offboarding_revocation_evidence_scope_key"
    UNIQUE ("id", "tenant_id", "venue_id", "plan_id")
);

CREATE TABLE "offboarding_export_artifacts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "kind" "OffboardingExportKind" NOT NULL,
  "artifact_reference" VARCHAR(500) NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offboarding_export_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_export_artifacts_reference_check"
    CHECK (char_length(btrim("artifact_reference")) BETWEEN 1 AND 500),
  CONSTRAINT "offboarding_export_artifacts_hash_check"
    CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "offboarding_export_artifacts_scope_key"
    UNIQUE ("id", "tenant_id", "venue_id", "plan_id")
);

CREATE INDEX "offboarding_plans_tenant_status_requested_id_idx"
  ON "offboarding_plans"("tenant_id", "status", "requested_at", "id");
CREATE INDEX "offboarding_venue_targets_tenant_venue_created_idx"
  ON "offboarding_venue_targets"("tenant_id", "venue_id", "created_at");
CREATE INDEX "offboarding_revocation_evidence_scope_recorded_idx"
  ON "offboarding_revocation_evidence"("tenant_id", "plan_id", "venue_id", "recorded_at", "id");
CREATE INDEX "offboarding_export_artifacts_scope_created_idx"
  ON "offboarding_export_artifacts"("tenant_id", "plan_id", "venue_id", "created_at", "id");

ALTER TABLE "offboarding_plans" ADD CONSTRAINT "offboarding_plans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_venue_targets" ADD CONSTRAINT "offboarding_venue_targets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_venue_targets" ADD CONSTRAINT "offboarding_venue_targets_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_venue_targets" ADD CONSTRAINT "offboarding_venue_targets_plan_scope_fkey"
  FOREIGN KEY ("plan_id", "tenant_id") REFERENCES "offboarding_plans"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "offboarding_revocation_evidence" ADD CONSTRAINT "offboarding_revocation_evidence_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_revocation_evidence" ADD CONSTRAINT "offboarding_revocation_evidence_target_scope_fkey"
  FOREIGN KEY ("plan_id", "tenant_id", "venue_id")
  REFERENCES "offboarding_venue_targets"("plan_id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "offboarding_export_artifacts" ADD CONSTRAINT "offboarding_export_artifacts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_export_artifacts" ADD CONSTRAINT "offboarding_export_artifacts_target_scope_fkey"
  FOREIGN KEY ("plan_id", "tenant_id", "venue_id")
  REFERENCES "offboarding_venue_targets"("plan_id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_reject_offboarding_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION pathfinder_reject_offboarding_plan_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be deleted or truncated', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER offboarding_plans_no_delete
  BEFORE DELETE ON "offboarding_plans"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_offboarding_plan_delete();
CREATE TRIGGER offboarding_plans_no_truncate
  BEFORE TRUNCATE ON "offboarding_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_plan_delete();

CREATE TRIGGER offboarding_venue_targets_append_only
  BEFORE UPDATE OR DELETE ON "offboarding_venue_targets"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();
CREATE TRIGGER offboarding_venue_targets_no_truncate
  BEFORE TRUNCATE ON "offboarding_venue_targets"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();
CREATE TRIGGER offboarding_revocation_evidence_append_only
  BEFORE UPDATE OR DELETE ON "offboarding_revocation_evidence"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();
CREATE TRIGGER offboarding_revocation_evidence_no_truncate
  BEFORE TRUNCATE ON "offboarding_revocation_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();
CREATE TRIGGER offboarding_export_artifacts_append_only
  BEFORE UPDATE OR DELETE ON "offboarding_export_artifacts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();
CREATE TRIGGER offboarding_export_artifacts_no_truncate
  BEFORE TRUNCATE ON "offboarding_export_artifacts"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();

COMMIT;

