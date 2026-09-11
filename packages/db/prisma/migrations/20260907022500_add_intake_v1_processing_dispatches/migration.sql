CREATE TYPE "IntakeV1ProcessingKind" AS ENUM ('WEBSITE_RESEARCH', 'REVIEW_READY', 'EXTRACTION_UNSUPPORTED');
CREATE TYPE "IntakeV1ProcessingStatus" AS ENUM ('PENDING', 'LEASED', 'COMPLETED', 'HELD', 'FAILED');

ALTER TABLE "intake_v1_submission_members"
  ADD CONSTRAINT "intake_v1_submission_members_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  ADD CONSTRAINT "intake_v1_submission_members_revision_scope_key" UNIQUE ("id", "revision_id", "tenant_id", "venue_id");

CREATE TABLE "intake_v1_processing_dispatches" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "intake_run_id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "kind" "IntakeV1ProcessingKind" NOT NULL,
  "status" "IntakeV1ProcessingStatus" NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "policy_version" VARCHAR(64) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_token" UUID,
  "lease_owner" VARCHAR(191),
  "lease_expires_at" TIMESTAMP(3),
  "receipt_id" UUID,
  "hold_reason" VARCHAR(64),
  "last_error" VARCHAR(500),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "intake_v1_processing_dispatches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_v1_processing_dispatches_member_key" UNIQUE ("member_id"),
  CONSTRAINT "intake_v1_processing_dispatches_member_scope_key" UNIQUE ("member_id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_v1_processing_dispatches_member_revision_scope_key" UNIQUE ("member_id", "revision_id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_v1_processing_dispatches_tenant_operation_key" UNIQUE ("tenant_id", "operation_id"),
  CONSTRAINT "intake_v1_processing_dispatches_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_v1_processing_dispatches_source_hash_check" CHECK ("source_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "intake_v1_processing_dispatches_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 3),
  CONSTRAINT "intake_v1_processing_dispatches_policy_check" CHECK (length("policy_version") BETWEEN 1 AND 64),
  CONSTRAINT "intake_v1_processing_dispatches_shape_check" CHECK (
    ("status" = 'PENDING' AND "kind" = 'WEBSITE_RESEARCH' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "receipt_id" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'LEASED' AND "kind" = 'WEBSITE_RESEARCH' AND "lease_token" IS NOT NULL AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "receipt_id" IS NULL AND "completed_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NOT NULL AND (("kind" = 'WEBSITE_RESEARCH' AND "receipt_id" IS NOT NULL) OR ("kind" = 'REVIEW_READY' AND "receipt_id" IS NULL)))
    OR ("status" = 'HELD' AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "hold_reason" IS NOT NULL AND "completed_at" IS NOT NULL AND (("kind" = 'WEBSITE_RESEARCH' AND "receipt_id" IS NOT NULL) OR ("kind" = 'EXTRACTION_UNSUPPORTED' AND "receipt_id" IS NULL)))
    OR ("status" = 'FAILED' AND "kind" = 'WEBSITE_RESEARCH' AND "attempts" = 3 AND "lease_token" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "receipt_id" IS NULL AND "last_error" IS NOT NULL AND "completed_at" IS NOT NULL)
  ),
  CONSTRAINT "intake_v1_processing_dispatches_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id") REFERENCES "intake_v1_submission_revisions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "intake_v1_processing_dispatches_member_scope_fkey" FOREIGN KEY ("member_id", "revision_id", "tenant_id", "venue_id") REFERENCES "intake_v1_submission_members"("id", "revision_id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "intake_v1_processing_dispatches_run_scope_fkey" FOREIGN KEY ("intake_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "intake_v1_processing_dispatches_receipt_scope_fkey" FOREIGN KEY ("receipt_id", "tenant_id", "venue_id") REFERENCES "intake_website_research_receipts"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
  ,CONSTRAINT "intake_v1_processing_dispatches_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
  ,CONSTRAINT "intake_v1_processing_dispatches_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "intake_v1_processing_dispatches_lease_idx" ON "intake_v1_processing_dispatches"("status", "lease_expires_at", "created_at");
CREATE INDEX "intake_v1_processing_dispatches_revision_idx" ON "intake_v1_processing_dispatches"("tenant_id", "venue_id", "revision_id");

CREATE FUNCTION pathfinder_validate_intake_v1_processing_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_row RECORD; receipt_row RECORD;
BEGIN
  SELECT member.immutable_hash, COALESCE(member.intake_run_id, upload.intake_run_id) AS intake_run_id
    INTO member_row FROM intake_v1_submission_members member
    LEFT JOIN intake_uploads upload ON upload.id=member.intake_upload_id AND upload.tenant_id=member.tenant_id AND upload.venue_id=member.venue_id
    WHERE member.id=NEW.member_id AND member.revision_id=NEW.revision_id AND member.tenant_id=NEW.tenant_id AND member.venue_id=NEW.venue_id;
  IF NOT FOUND OR member_row.immutable_hash IS DISTINCT FROM NEW.source_hash OR member_row.intake_run_id IS DISTINCT FROM NEW.intake_run_id
  THEN RAISE EXCEPTION 'intake V1 processing source identity mismatch'; END IF;
  IF NEW.kind='WEBSITE_RESEARCH' AND NOT EXISTS (
    SELECT 1 FROM intake_runs WHERE id=NEW.intake_run_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id
      AND source_kind='WEBSITE' AND submission_input_hash=NEW.source_hash
  ) THEN RAISE EXCEPTION 'intake V1 website processing source hash mismatch'; END IF;
  IF NEW.receipt_id IS NOT NULL THEN
    SELECT run_id, outcome INTO receipt_row FROM intake_website_research_receipts
      WHERE id=NEW.receipt_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
    IF NOT FOUND OR receipt_row.run_id IS DISTINCT FROM NEW.intake_run_id
      OR (NEW.status='COMPLETED' AND receipt_row.outcome <> 'SUCCEEDED')
      OR (NEW.status='HELD' AND receipt_row.outcome = 'SUCCEEDED')
    THEN RAISE EXCEPTION 'intake V1 processing receipt identity mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intake_v1_processing_dispatches_source_guard BEFORE INSERT OR UPDATE ON "intake_v1_processing_dispatches" FOR EACH ROW EXECUTE FUNCTION pathfinder_validate_intake_v1_processing_dispatch();

CREATE FUNCTION pathfinder_guard_intake_v1_processing_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.venue_id, NEW.revision_id, NEW.member_id, NEW.intake_run_id, NEW.operation_id, NEW.kind, NEW.source_hash, NEW.policy_version, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.venue_id, OLD.revision_id, OLD.member_id, OLD.intake_run_id, OLD.operation_id, OLD.kind, OLD.source_hash, OLD.policy_version, OLD.created_at)
  THEN RAISE EXCEPTION 'intake V1 processing dispatch immutable identity cannot change'; END IF;
  IF OLD.status IN ('COMPLETED', 'HELD', 'FAILED') THEN RAISE EXCEPTION 'terminal intake V1 processing dispatch cannot change'; END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > 3 THEN RAISE EXCEPTION 'invalid intake V1 processing attempt transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intake_v1_processing_dispatches_lifecycle_guard BEFORE UPDATE ON "intake_v1_processing_dispatches" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_intake_v1_processing_dispatch();
CREATE TRIGGER intake_v1_processing_dispatches_no_delete BEFORE DELETE ON "intake_v1_processing_dispatches" FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
CREATE TRIGGER intake_v1_processing_dispatches_no_truncate BEFORE TRUNCATE ON "intake_v1_processing_dispatches" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();
