BEGIN;

CREATE TYPE "VenuePackageStatus" AS ENUM ('DRAFT', 'APPROVED', 'APPLIED', 'REVERTED');

CREATE TABLE "venue_packages" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "draft_key" UUID NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "base_digest" CHAR(64) NOT NULL,
  "validation_report" JSONB NOT NULL,
  "preview_plan" JSONB NOT NULL,
  "status" "VenuePackageStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "approved_command_key" UUID,
  "approval_warning_digest" CHAR(64),
  "approved_warning_codes" JSONB,
  "applied_by" TEXT,
  "applied_at" TIMESTAMP(3),
  "applied_command_key" UUID,
  "applied_entities" JSONB,
  "reverted_by" TEXT,
  "reverted_at" TIMESTAMP(3),
  "reverted_command_key" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_packages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "venue_packages_lifecycle_check" CHECK (
    ("status" = 'DRAFT'
      AND "approved_by" IS NULL AND "approved_at" IS NULL AND "approved_command_key" IS NULL
      AND "approval_warning_digest" IS NULL AND "approved_warning_codes" IS NULL
      AND "applied_by" IS NULL AND "applied_at" IS NULL AND "applied_command_key" IS NULL
      AND "applied_entities" IS NULL
      AND "reverted_by" IS NULL AND "reverted_at" IS NULL AND "reverted_command_key" IS NULL)
    OR
    ("status" = 'APPROVED'
      AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL
      AND "approved_command_key" IS NOT NULL AND "approval_warning_digest" IS NOT NULL
      AND "approved_warning_codes" IS NOT NULL
      AND "applied_by" IS NULL AND "applied_at" IS NULL AND "applied_command_key" IS NULL
      AND "applied_entities" IS NULL
      AND "reverted_by" IS NULL AND "reverted_at" IS NULL AND "reverted_command_key" IS NULL)
    OR
    ("status" = 'APPLIED'
      AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL
      AND "approved_command_key" IS NOT NULL AND "approval_warning_digest" IS NOT NULL
      AND "approved_warning_codes" IS NOT NULL
      AND "applied_by" IS NOT NULL AND "applied_at" IS NOT NULL
      AND "applied_command_key" IS NOT NULL AND "applied_entities" IS NOT NULL
      AND "reverted_by" IS NULL AND "reverted_at" IS NULL AND "reverted_command_key" IS NULL)
    OR
    ("status" = 'REVERTED'
      AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL
      AND "approved_command_key" IS NOT NULL AND "approval_warning_digest" IS NOT NULL
      AND "approved_warning_codes" IS NOT NULL
      AND "applied_by" IS NOT NULL AND "applied_at" IS NOT NULL
      AND "applied_command_key" IS NOT NULL AND "applied_entities" IS NOT NULL
      AND "reverted_by" IS NOT NULL AND "reverted_at" IS NOT NULL
      AND "reverted_command_key" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "venue_packages_tenant_id_venue_id_draft_key_key"
  ON "venue_packages"("tenant_id", "venue_id", "draft_key");
CREATE UNIQUE INDEX "venue_packages_tenant_id_approved_command_key_key"
  ON "venue_packages"("tenant_id", "approved_command_key");
CREATE UNIQUE INDEX "venue_packages_tenant_id_applied_command_key_key"
  ON "venue_packages"("tenant_id", "applied_command_key");
CREATE UNIQUE INDEX "venue_packages_tenant_id_reverted_command_key_key"
  ON "venue_packages"("tenant_id", "reverted_command_key");
CREATE INDEX "venue_packages_tenant_id_venue_id_created_at_idx"
  ON "venue_packages"("tenant_id", "venue_id", "created_at");
CREATE INDEX "venue_packages_tenant_id_status_updated_at_idx"
  ON "venue_packages"("tenant_id", "status", "updated_at");

CREATE FUNCTION pathfinder_guard_venue_package_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'venue package revisions are immutable';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."draft_key" IS DISTINCT FROM OLD."draft_key"
    OR NEW."schema_version" IS DISTINCT FROM OLD."schema_version"
    OR NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."payload_hash" IS DISTINCT FROM OLD."payload_hash"
    OR NEW."base_digest" IS DISTINCT FROM OLD."base_digest"
    OR NEW."validation_report" IS DISTINCT FROM OLD."validation_report"
    OR NEW."preview_plan" IS DISTINCT FROM OLD."preview_plan"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'venue package revision content is immutable';
  END IF;

  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED')
    OR (OLD."status" = 'APPROVED' AND NEW."status" = 'APPLIED')
    OR (OLD."status" = 'APPLIED' AND NEW."status" = 'REVERTED')
  ) THEN
    RAISE EXCEPTION 'invalid venue package lifecycle transition';
  END IF;

  IF OLD."status" <> 'DRAFT'
    AND (NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
      OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
      OR NEW."approved_command_key" IS DISTINCT FROM OLD."approved_command_key"
      OR NEW."approval_warning_digest" IS DISTINCT FROM OLD."approval_warning_digest"
      OR NEW."approved_warning_codes" IS DISTINCT FROM OLD."approved_warning_codes")
  THEN
    RAISE EXCEPTION 'venue package approval attribution is immutable';
  END IF;

  IF OLD."status" = 'APPLIED'
    AND (NEW."applied_by" IS DISTINCT FROM OLD."applied_by"
      OR NEW."applied_at" IS DISTINCT FROM OLD."applied_at"
      OR NEW."applied_command_key" IS DISTINCT FROM OLD."applied_command_key"
      OR NEW."applied_entities" IS DISTINCT FROM OLD."applied_entities")
  THEN
    RAISE EXCEPTION 'venue package application evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION pathfinder_guard_venue_package_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'venue package revisions are immutable';
END;
$$;

CREATE TRIGGER venue_packages_revision_guard
  BEFORE UPDATE OR DELETE ON "venue_packages"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_venue_package_revision();

CREATE TRIGGER venue_packages_truncate_guard
  BEFORE TRUNCATE ON "venue_packages"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_venue_package_truncate();

COMMIT;
