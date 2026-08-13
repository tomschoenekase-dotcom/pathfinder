BEGIN;

CREATE TYPE "OffboardingExportOperationStatus" AS ENUM ('RESERVED', 'STORED', 'SETTLED');

ALTER TABLE "offboarding_plans"
  ADD COLUMN "export_review_operation_id" UUID,
  ADD COLUMN "export_review_operation_hash" CHAR(64),
  ADD COLUMN "export_reviewed_by" VARCHAR(191),
  ADD COLUMN "export_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "export_review_audit_id" TEXT,
  ADD CONSTRAINT "offboarding_plans_export_review_operation_key" UNIQUE ("export_review_operation_id"),
  ADD CONSTRAINT "offboarding_plans_export_review_audit_key" UNIQUE ("export_review_audit_id"),
  ADD CONSTRAINT "offboarding_plans_export_review_evidence_check" CHECK (
    (("export_review_operation_id" IS NULL) = ("export_review_operation_hash" IS NULL))
    AND (("export_review_operation_id" IS NULL) = ("export_reviewed_by" IS NULL))
    AND (("export_review_operation_id" IS NULL) = ("export_reviewed_at" IS NULL))
    AND (("export_review_operation_id" IS NULL) = ("export_review_audit_id" IS NULL))
    AND ("export_review_operation_hash" IS NULL OR "export_review_operation_hash" ~ '^[a-f0-9]{64}$')
    AND ("export_reviewed_by" IS NULL OR char_length(btrim("export_reviewed_by")) BETWEEN 1 AND 191)
  );

CREATE TABLE "offboarding_export_operations" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "kind" "OffboardingExportKind" NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "status" "OffboardingExportOperationStatus" NOT NULL DEFAULT 'RESERVED',
  "canonical_manifest" JSONB NOT NULL,
  "canonical_bytes" TEXT NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "byte_length" INTEGER NOT NULL,
  "object_key" VARCHAR(500) NOT NULL,
  "expected_plan_updated_at" TIMESTAMP(3) NOT NULL,
  "requested_by" VARCHAR(191) NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL,
  "stored_version_id" VARCHAR(500),
  "stored_at" TIMESTAMP(3),
  "settled_at" TIMESTAMP(3),
  "settlement_audit_id" TEXT,
  CONSTRAINT "offboarding_export_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offboarding_export_operations_scope_key" UNIQUE ("id", "tenant_id", "venue_id", "plan_id"),
  CONSTRAINT "offboarding_export_operations_tuple_key" UNIQUE ("tenant_id", "plan_id", "venue_id", "kind"),
  CONSTRAINT "offboarding_export_operations_settlement_audit_key" UNIQUE ("settlement_audit_id"),
  CONSTRAINT "offboarding_export_operations_hashes_check" CHECK (
    "operation_hash" ~ '^[a-f0-9]{64}$' AND "content_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "offboarding_export_operations_bounds_check" CHECK (
    "byte_length" BETWEEN 2 AND 1048576
    AND char_length(btrim("object_key")) BETWEEN 1 AND 500
    AND "object_key" ~ '^offboarding/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,191}/[A-Za-z0-9_-]{1,191}/(APPROVED_CONTENT|CONTENT_HISTORY|VENUE_PACKAGES|CONFIGURATION|AUDIT_HISTORY)\.json$'
    AND "object_key" !~ '(\.\.|//|[?#\\])'
    AND char_length(btrim("requested_by")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "offboarding_export_operations_manifest_check" CHECK (
    jsonb_typeof("canonical_manifest") = 'object'
    AND ("canonical_manifest"->>'schemaVersion') IS NOT DISTINCT FROM '1'
    AND ("canonical_manifest"->>'privacyBoundary') IS NOT DISTINCT FROM 'BOUNDED_EXPORT_EVIDENCE'
    AND ("canonical_manifest"->>'tenantId') IS NOT DISTINCT FROM "tenant_id"
    AND ("canonical_manifest"->>'venueId') IS NOT DISTINCT FROM "venue_id"
    AND ("canonical_manifest"->>'planId') IS NOT DISTINCT FROM "plan_id"
    AND ("canonical_manifest"->>'kind') IS NOT DISTINCT FROM "kind"::text
    AND ("canonical_manifest"->>'sourceComplete') IS NOT DISTINCT FROM 'true'
    AND "canonical_bytes"::jsonb IS NOT DISTINCT FROM "canonical_manifest"
  ),
  CONSTRAINT "offboarding_export_operations_state_check" CHECK (
    ("status" = 'RESERVED' AND "stored_version_id" IS NULL AND "stored_at" IS NULL AND "settled_at" IS NULL AND "settlement_audit_id" IS NULL)
    OR ("status" = 'STORED' AND "stored_version_id" IS NOT NULL AND "stored_at" IS NOT NULL AND "settled_at" IS NULL AND "settlement_audit_id" IS NULL)
    OR ("status" = 'SETTLED' AND "stored_version_id" IS NOT NULL AND "stored_at" IS NOT NULL AND "settled_at" IS NOT NULL AND "settlement_audit_id" IS NOT NULL)
  ),
  CONSTRAINT "offboarding_export_operations_storage_evidence_check" CHECK (
    ("stored_version_id" IS NULL OR char_length(btrim("stored_version_id")) BETWEEN 1 AND 500)
    AND ("stored_at" IS NULL OR "stored_at" >= "requested_at")
    AND ("settled_at" IS NULL OR ("stored_at" IS NOT NULL AND "settled_at" >= "stored_at"))
  )
);

CREATE FUNCTION pathfinder_offboarding_manifest_records_valid(manifest jsonb, export_kind "OffboardingExportKind")
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
DECLARE record jsonb; expected text; cap integer;
BEGIN
  IF jsonb_typeof(manifest) <> 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(manifest) key)
       IS DISTINCT FROM ARRAY['kind','planId','privacyBoundary','recordCount','records','schemaVersion','sourceComplete','tenantId','venueId']
    OR jsonb_typeof(manifest->'records') <> 'array'
    OR jsonb_typeof(manifest->'recordCount') <> 'number' THEN RETURN false; END IF;
  cap := CASE export_kind WHEN 'APPROVED_CONTENT' THEN 1000 WHEN 'CONTENT_HISTORY' THEN 2000
    WHEN 'VENUE_PACKAGES' THEN 500 WHEN 'CONFIGURATION' THEN 100 ELSE 2000 END;
  IF (manifest->>'recordCount')::integer IS DISTINCT FROM jsonb_array_length(manifest->'records')
    OR jsonb_array_length(manifest->'records') > cap THEN RETURN false; END IF;
  expected := CASE export_kind WHEN 'APPROVED_CONTENT' THEN 'APPROVED_PUBLIC'
    WHEN 'CONTENT_HISTORY' THEN 'CLIENT_HISTORY' WHEN 'VENUE_PACKAGES' THEN 'PACKAGE_EVIDENCE'
    WHEN 'CONFIGURATION' THEN 'SAFE_CONFIGURATION' ELSE 'DIRECT_VENUE_AUDIT_REFERENCE' END;
  FOR record IN SELECT value FROM jsonb_array_elements(manifest->'records') LOOP
    IF jsonb_typeof(record) <> 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(record) key)
         IS DISTINCT FROM ARRAY['classification','id','recordedAt','version']
      OR jsonb_typeof(record->'id') <> 'string' OR char_length(btrim(record->>'id')) NOT BETWEEN 1 AND 191
      OR jsonb_typeof(record->'version') <> 'string' OR char_length(btrim(record->>'version')) NOT BETWEEN 1 AND 191
      OR jsonb_typeof(record->'recordedAt') <> 'string' OR (record->>'recordedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      OR record->>'classification' IS DISTINCT FROM expected THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE "offboarding_export_operations" ADD CONSTRAINT "offboarding_export_operations_records_check"
  CHECK (pathfinder_offboarding_manifest_records_valid("canonical_manifest", "kind"));

ALTER TABLE "offboarding_export_operations" ADD CONSTRAINT "offboarding_export_operations_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_export_operations" ADD CONSTRAINT "offboarding_export_operations_target_fkey"
  FOREIGN KEY ("plan_id", "tenant_id", "venue_id")
  REFERENCES "offboarding_venue_targets"("plan_id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_plans" ADD CONSTRAINT "offboarding_plans_export_review_audit_fkey"
  FOREIGN KEY ("export_review_audit_id") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offboarding_export_operations" ADD CONSTRAINT "offboarding_export_operations_settlement_audit_fkey"
  FOREIGN KEY ("settlement_audit_id") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "offboarding_export_artifacts" ADD COLUMN "operation_id" UUID;
ALTER TABLE "offboarding_export_artifacts" ADD CONSTRAINT "offboarding_export_artifacts_operation_key" UNIQUE ("operation_id");
ALTER TABLE "offboarding_export_artifacts" ADD CONSTRAINT "offboarding_export_artifacts_operation_scope_key"
  UNIQUE ("operation_id", "tenant_id", "venue_id", "plan_id");
ALTER TABLE "offboarding_export_artifacts" ADD CONSTRAINT "offboarding_export_artifacts_operation_fkey"
  FOREIGN KEY ("operation_id", "tenant_id", "venue_id", "plan_id")
  REFERENCES "offboarding_export_operations"("id", "tenant_id", "venue_id", "plan_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "offboarding_export_operations_scope_status_idx"
  ON "offboarding_export_operations"("tenant_id", "plan_id", "status", "requested_at", "id");

CREATE FUNCTION pathfinder_guard_offboarding_export_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  target_plan public.offboarding_plans%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p.* INTO target_plan
    FROM public.offboarding_plans p
    JOIN public.offboarding_venue_targets t
      ON t.plan_id = p.id AND t.tenant_id = p.tenant_id
    WHERE p.id = NEW.plan_id AND p.tenant_id = NEW.tenant_id AND t.venue_id = NEW.venue_id
    FOR UPDATE OF p;
    IF NOT FOUND OR target_plan.status <> 'REVIEWED'
      OR NOT (NEW.kind = ANY(target_plan.export_kinds))
      OR NEW.expected_plan_updated_at IS DISTINCT FROM target_plan.updated_at THEN
      RAISE EXCEPTION 'offboarding export reservation scope/status/version mismatch';
    END IF;
    IF NEW.status <> 'RESERVED' THEN
      RAISE EXCEPTION 'offboarding export operation must begin reserved';
    END IF;
    IF NEW.operation_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'pathfinder.offboarding-export-finalization.v1|' || NEW.tenant_id || '|' || NEW.plan_id || '|' || NEW.venue_id || '|' || NEW.kind::text || '|' || NEW.id::text || '|' || to_char(NEW.expected_plan_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || NEW.requested_by,
      'UTF8')), 'hex') THEN RAISE EXCEPTION 'offboarding export operation hash mismatch'; END IF;
    IF NEW.content_hash IS DISTINCT FROM pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.canonical_bytes, 'UTF8')), 'hex')
      OR NEW.byte_length IS DISTINCT FROM octet_length(pg_catalog.convert_to(NEW.canonical_bytes, 'UTF8')) THEN
      RAISE EXCEPTION 'offboarding export manifest hash or byte length mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'offboarding export operations are not deletable'; END IF;
  IF ROW(NEW.id, NEW.tenant_id, NEW.venue_id, NEW.plan_id, NEW.kind, NEW.operation_hash,
         NEW.canonical_manifest, NEW.canonical_bytes, NEW.content_hash, NEW.byte_length, NEW.object_key,
         NEW.expected_plan_updated_at, NEW.requested_by, NEW.requested_at,
         CASE WHEN OLD.status <> 'RESERVED' THEN NEW.stored_version_id END,
         CASE WHEN OLD.status <> 'RESERVED' THEN NEW.stored_at END)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.venue_id, OLD.plan_id, OLD.kind, OLD.operation_hash,
         OLD.canonical_manifest, OLD.canonical_bytes, OLD.content_hash, OLD.byte_length, OLD.object_key,
         OLD.expected_plan_updated_at, OLD.requested_by, OLD.requested_at,
         CASE WHEN OLD.status <> 'RESERVED' THEN OLD.stored_version_id END,
         CASE WHEN OLD.status <> 'RESERVED' THEN OLD.stored_at END) THEN
    RAISE EXCEPTION 'offboarding export reservation evidence is immutable';
  END IF;
  IF NOT ((OLD.status = 'RESERVED' AND NEW.status = 'STORED') OR
          (OLD.status = 'STORED' AND NEW.status = 'SETTLED')) THEN
    RAISE EXCEPTION 'invalid offboarding export operation transition';
  END IF;
  SELECT p.* INTO target_plan FROM public.offboarding_plans p
    WHERE p.id = NEW.plan_id AND p.tenant_id = NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR target_plan.status <> 'REVIEWED'
    OR target_plan.updated_at IS DISTINCT FROM NEW.expected_plan_updated_at
    OR NOT (NEW.kind = ANY(target_plan.export_kinds)) THEN
    RAISE EXCEPTION 'offboarding export operation plan changed before settlement';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offboarding_export_operations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "offboarding_export_operations"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_offboarding_export_operation();
CREATE TRIGGER offboarding_export_operations_no_truncate
  BEFORE TRUNCATE ON "offboarding_export_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_offboarding_evidence_mutation();

CREATE FUNCTION pathfinder_guard_offboarding_export_artifact_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE op public.offboarding_export_operations%ROWTYPE;
BEGIN
  IF NEW.operation_id IS NULL THEN
    RAISE EXCEPTION 'new offboarding export artifacts require an operation';
  END IF;
  SELECT * INTO op FROM public.offboarding_export_operations WHERE id = NEW.operation_id FOR UPDATE;
  IF NOT FOUND OR op.status <> 'STORED'
    OR ROW(NEW.tenant_id, NEW.venue_id, NEW.plan_id, NEW.kind, NEW.artifact_reference, NEW.content_hash, NEW.created_by)
       IS DISTINCT FROM
       ROW(op.tenant_id, op.venue_id, op.plan_id, op.kind, op.object_key, op.content_hash, op.requested_by) OR
       NEW.created_at IS DISTINCT FROM op.stored_at THEN
    RAISE EXCEPTION 'offboarding export artifact does not match stored operation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offboarding_export_artifacts_insert_guard
  BEFORE INSERT ON "offboarding_export_artifacts"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_offboarding_export_artifact_insert();

CREATE FUNCTION pathfinder_guard_offboarding_export_ready() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE required_count integer; complete_count integer;
BEGIN
  IF NEW.status = 'EXPORT_READY' AND OLD.status IS DISTINCT FROM 'EXPORT_READY' THEN
    IF OLD.status <> 'REVIEWED' THEN RAISE EXCEPTION 'export ready requires reviewed plan'; END IF;
    SELECT count(*) * cardinality(NEW.export_kinds) INTO required_count
      FROM public.offboarding_venue_targets WHERE tenant_id = NEW.tenant_id AND plan_id = NEW.id;
    SELECT count(*) INTO complete_count FROM public.offboarding_export_artifacts a
      JOIN public.offboarding_export_operations o ON o.id = a.operation_id
      WHERE a.tenant_id = NEW.tenant_id AND a.plan_id = NEW.id AND o.status = 'SETTLED';
    IF required_count = 0 OR complete_count IS DISTINCT FROM required_count THEN
      RAISE EXCEPTION 'export ready requires every declared target and kind';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offboarding_plans_export_ready_guard
  BEFORE UPDATE ON "offboarding_plans"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_offboarding_export_ready();

CREATE FUNCTION pathfinder_guard_offboarding_plan_finalization_universe() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.revocation_targets, NEW.export_kinds, NEW.effective_at, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.revocation_targets, OLD.export_kinds, OLD.effective_at, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'offboarding plan finalization universe is immutable';
  END IF;
  IF OLD.export_review_operation_id IS NOT NULL AND
     ROW(NEW.export_review_operation_id, NEW.export_review_operation_hash, NEW.export_reviewed_by, NEW.export_reviewed_at, NEW.export_review_audit_id)
     IS DISTINCT FROM
     ROW(OLD.export_review_operation_id, OLD.export_review_operation_hash, OLD.export_reviewed_by, OLD.export_reviewed_at, OLD.export_review_audit_id) THEN
    RAISE EXCEPTION 'offboarding export review evidence is immutable';
  END IF;
  IF OLD.status = 'REQUESTED' AND NEW.status = 'REVIEWED' AND
     (NEW.export_review_operation_id IS NULL OR NEW.export_reviewed_at IS DISTINCT FROM NEW.updated_at) THEN
    RAISE EXCEPTION 'reviewed offboarding plan requires exact review evidence';
  END IF;
  IF OLD.export_review_operation_id IS NULL AND NEW.export_review_operation_id IS NOT NULL AND NEW.export_review_operation_hash IS DISTINCT FROM
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'pathfinder.offboarding-export-review.v1|' || NEW.tenant_id || '|' || NEW.id || '|' || to_char(OLD.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || NEW.export_reviewed_by || '|' || NEW.export_review_operation_id::text,
      'UTF8')), 'hex') THEN RAISE EXCEPTION 'offboarding export review operation hash mismatch'; END IF;
  IF OLD.status = 'REVIEWED' AND NEW.status NOT IN ('REVIEWED', 'EXPORT_READY', 'CANCELLED') THEN
    RAISE EXCEPTION 'invalid reviewed offboarding plan transition';
  END IF;
  IF OLD.status = 'REQUESTED' AND NEW.status NOT IN ('REQUESTED', 'REVIEWED', 'CANCELLED') THEN
    RAISE EXCEPTION 'requested offboarding plan cannot enter an unsupported execution state';
  END IF;
  IF OLD.status = 'REVIEWED' AND NEW.status = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM public.offboarding_export_operations o
    WHERE o.tenant_id = OLD.tenant_id AND o.plan_id = OLD.id AND o.status <> 'SETTLED'
  ) THEN
    RAISE EXCEPTION 'offboarding plan with unfinished export operations cannot be cancelled';
  END IF;
  IF OLD.status = 'EXPORT_READY' AND NEW.status NOT IN ('EXPORT_READY', 'CANCELLED') THEN
    RAISE EXCEPTION 'export ready plan cannot advance without separate execution evidence';
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'cancelled offboarding plan is terminal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offboarding_plans_finalization_universe_guard
  BEFORE UPDATE ON "offboarding_plans"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_offboarding_plan_finalization_universe();

CREATE FUNCTION pathfinder_validate_offboarding_export_audits() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE audit public.audit_logs%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'offboarding_plans' AND NEW.status = 'REVIEWED' THEN
    SELECT * INTO audit FROM public.audit_logs WHERE id = NEW.export_review_audit_id;
    IF NOT FOUND OR audit.tenant_id IS DISTINCT FROM NEW.tenant_id OR audit.actor_id IS DISTINCT FROM NEW.export_reviewed_by
      OR audit.actor_role IS DISTINCT FROM 'PLATFORM_ADMIN' OR audit.action IS DISTINCT FROM 'offboarding-plan.export-reviewed'
      OR audit.target_type IS DISTINCT FROM 'OffboardingPlan' OR audit.target_id IS DISTINCT FROM NEW.id
      OR audit.created_at IS DISTINCT FROM NEW.export_reviewed_at OR audit.before_state IS DISTINCT FROM '{"status":"REQUESTED"}'::jsonb
      OR audit.after_state->>'status' IS DISTINCT FROM 'REVIEWED'
      OR audit.after_state->'exportKinds' IS DISTINCT FROM to_jsonb(NEW.export_kinds)
      OR (audit.after_state->>'venueCount')::integer IS DISTINCT FROM (SELECT count(*)::integer FROM public.offboarding_venue_targets t WHERE t.tenant_id=NEW.tenant_id AND t.plan_id=NEW.id)
      THEN RAISE EXCEPTION 'offboarding review audit mismatch'; END IF;
  ELSIF TG_TABLE_NAME = 'offboarding_export_operations' AND NEW.status = 'SETTLED' THEN
    SELECT * INTO audit FROM public.audit_logs WHERE id = NEW.settlement_audit_id;
    IF NOT FOUND OR audit.tenant_id IS DISTINCT FROM NEW.tenant_id OR audit.actor_id IS DISTINCT FROM NEW.requested_by
      OR audit.actor_role IS DISTINCT FROM 'PLATFORM_ADMIN' OR audit.action IS DISTINCT FROM 'offboarding-export.artifact-finalized'
      OR audit.target_type IS DISTINCT FROM 'OffboardingPlan' OR audit.target_id IS DISTINCT FROM NEW.plan_id
      OR audit.created_at IS DISTINCT FROM NEW.settled_at
      OR audit.after_state->>'venueId' IS DISTINCT FROM NEW.venue_id
      OR audit.after_state->>'kind' IS DISTINCT FROM NEW.kind::text
      OR audit.after_state->>'operationId' IS DISTINCT FROM NEW.id::text
      OR (audit.after_state->>'byteLength')::integer IS DISTINCT FROM NEW.byte_length
      THEN RAISE EXCEPTION 'offboarding settlement audit mismatch'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER offboarding_plan_review_audit_guard AFTER INSERT OR UPDATE ON "offboarding_plans"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pathfinder_validate_offboarding_export_audits();
CREATE CONSTRAINT TRIGGER offboarding_export_settlement_audit_guard AFTER INSERT OR UPDATE ON "offboarding_export_operations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pathfinder_validate_offboarding_export_audits();

COMMIT;
