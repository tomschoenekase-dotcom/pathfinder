-- Forward-only NATIVE_CORE_V1 deployment evidence. No legacy rows are backfilled.
CREATE TYPE "NativeVenueDeploymentReleaseStatus" AS ENUM ('DRAFT', 'APPROVED', 'APPLIED', 'REVERTED');
CREATE TYPE "NativeVenueDeploymentEffectKind" AS ENUM ('VENUE', 'PLACE', 'KNOWLEDGE', 'GENERALIZED_MODULE', 'GENERALIZED_PUBLICATION');
CREATE TYPE "NativeVenueDeploymentCommandKind" AS ENUM ('APPROVE', 'APPLY', 'REVERT');

CREATE TABLE "native_venue_deployment_artifacts" (
  "id" UUID PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "profile" VARCHAR(64) NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "canonical_manifest" JSONB NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "base_state_hash" CHAR(64) NOT NULL,
  "desired_state_hash" CHAR(64) NOT NULL,
  "base_universe" JSONB NOT NULL,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_artifact_profile_check" CHECK ("profile" = 'NATIVE_CORE_V1'),
  CONSTRAINT "native_artifact_shape_check" CHECK (
    jsonb_typeof("canonical_manifest") = 'object' AND
    "canonical_manifest"->>'materializationProfile' = "profile" AND
    "canonical_manifest"->>'manifestId' = "id"::text AND
    "canonical_manifest"->>'idempotencyKey' = "idempotency_key"::text AND
    "canonical_manifest"->>'venueRef' = "venue_id" AND
    "canonical_manifest"->'baseState'->>'stateHash' = "base_state_hash" AND
    "canonical_manifest"->'baseState' = "base_universe" AND
    "created_by" <> ''
  )
);
CREATE UNIQUE INDEX "native_venue_artifacts_idempotency_key" ON "native_venue_deployment_artifacts"("tenant_id", "venue_id", "idempotency_key");
CREATE UNIQUE INDEX "native_venue_artifacts_manifest_hash_key" ON "native_venue_deployment_artifacts"("tenant_id", "venue_id", "manifest_hash");
CREATE UNIQUE INDEX "native_venue_artifacts_scope_key" ON "native_venue_deployment_artifacts"("id", "tenant_id", "venue_id");
CREATE INDEX "native_venue_artifacts_scope_idx" ON "native_venue_deployment_artifacts"("tenant_id", "venue_id", "created_at");

CREATE TABLE "native_venue_deployment_releases" (
  "id" UUID PRIMARY KEY, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "artifact_id" UUID NOT NULL UNIQUE, "profile" VARCHAR(64) NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL, "base_state_hash" CHAR(64) NOT NULL,
  "desired_state_hash" CHAR(64) NOT NULL, "plan_hash" CHAR(64) NOT NULL, "expected_effect_count" INTEGER NOT NULL,
  "replacement_universe" JSONB NOT NULL, "plan" JSONB NOT NULL,
  "status" "NativeVenueDeploymentReleaseStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by" VARCHAR(191) NOT NULL,
  "approved_by" VARCHAR(191), "approved_at" TIMESTAMP(3), "approved_command_id" UUID, "approved_command_hash" CHAR(64),
  "applied_by" VARCHAR(191), "applied_at" TIMESTAMP(3), "applied_command_id" UUID, "applied_command_hash" CHAR(64),
  "reverted_by" VARCHAR(191), "reverted_at" TIMESTAMP(3), "reverted_command_id" UUID, "reverted_command_hash" CHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "native_release_profile_check" CHECK ("profile" = 'NATIVE_CORE_V1' AND jsonb_typeof("plan")='object' AND jsonb_typeof("replacement_universe")='object')
);
CREATE UNIQUE INDEX "native_venue_deployment_releases_scope_key" ON "native_venue_deployment_releases"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "native_venue_deployment_releases_artifact_scope_key" ON "native_venue_deployment_releases"("artifact_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "native_venue_deployment_releases_approved_key" ON "native_venue_deployment_releases"("tenant_id", "approved_command_id");
CREATE UNIQUE INDEX "native_venue_deployment_releases_applied_key" ON "native_venue_deployment_releases"("tenant_id", "applied_command_id");
CREATE UNIQUE INDEX "native_venue_deployment_releases_reverted_key" ON "native_venue_deployment_releases"("tenant_id", "reverted_command_id");
CREATE INDEX "native_venue_deployment_releases_scope_idx" ON "native_venue_deployment_releases"("tenant_id", "venue_id", "status", "created_at");

CREATE TABLE "native_venue_deployment_effects" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "release_id" UUID NOT NULL, "effect_order" INTEGER NOT NULL,
  "kind" "NativeVenueDeploymentEffectKind" NOT NULL, "target_id" VARCHAR(191) NOT NULL,
  "before_hash" CHAR(64) NOT NULL, "after_hash" CHAR(64) NOT NULL,
  "before_state" JSONB NOT NULL, "after_state" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_effect_shape_check" CHECK (
    "effect_order" > 0 AND "target_id" <> '' AND
    jsonb_typeof("before_state")='object' AND jsonb_typeof("after_state")='object' AND
    "before_state" ? 'present' AND "before_state" ? 'value' AND
    "after_state" ? 'present' AND "after_state" ? 'value' AND
    (("before_state"->>'present')::boolean = ("before_state"->'value' IS NOT NULL)) AND
    (("after_state"->>'present')::boolean = ("after_state"->'value' IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "native_venue_deployment_effects_order_key" ON "native_venue_deployment_effects"("release_id", "effect_order");
CREATE UNIQUE INDEX "native_venue_deployment_effects_scope_key" ON "native_venue_deployment_effects"("id", "tenant_id", "venue_id");
CREATE INDEX "native_venue_deployment_effects_release_idx" ON "native_venue_deployment_effects"("tenant_id", "venue_id", "release_id", "effect_order");

CREATE TABLE "native_venue_deployment_heads" (
  "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL, "release_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL, "manifest_hash" CHAR(64) NOT NULL, "state_hash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("tenant_id", "venue_id"), CONSTRAINT "native_head_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "native_venue_deployment_heads_venue_key" ON "native_venue_deployment_heads"("venue_id", "tenant_id");
CREATE UNIQUE INDEX "native_venue_deployment_heads_release_key" ON "native_venue_deployment_heads"("release_id", "tenant_id", "venue_id");

CREATE TABLE "native_venue_deployment_commands" (
  "id" UUID PRIMARY KEY, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL, "release_id" UUID NOT NULL,
  "kind" "NativeVenueDeploymentCommandKind" NOT NULL, "command_hash" CHAR(64) NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL, "produced_status" "NativeVenueDeploymentReleaseStatus" NOT NULL,
  "produced_snapshot" JSONB NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "native_command_shape_check" CHECK ("actor_id" <> '' AND jsonb_typeof("produced_snapshot")='object' AND
    (("kind"='APPROVE' AND "produced_status"='APPROVED') OR ("kind"='APPLY' AND "produced_status"='APPLIED') OR ("kind"='REVERT' AND "produced_status"='REVERTED')))
);
CREATE UNIQUE INDEX "native_venue_commands_scope_key" ON "native_venue_deployment_commands"("tenant_id", "venue_id", "id");
CREATE INDEX "native_venue_commands_release_idx" ON "native_venue_deployment_commands"("tenant_id", "venue_id", "release_id", "created_at");

ALTER TABLE "native_venue_deployment_artifacts" ADD CONSTRAINT "native_artifacts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_artifacts" ADD CONSTRAINT "native_artifacts_venue_fk" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_releases" ADD CONSTRAINT "native_releases_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_releases" ADD CONSTRAINT "native_releases_venue_fk" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_releases" ADD CONSTRAINT "native_releases_artifact_fk" FOREIGN KEY ("artifact_id","tenant_id","venue_id") REFERENCES "native_venue_deployment_artifacts"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_effects" ADD CONSTRAINT "native_effects_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_effects" ADD CONSTRAINT "native_effects_venue_fk" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_effects" ADD CONSTRAINT "native_effects_release_fk" FOREIGN KEY ("release_id","tenant_id","venue_id") REFERENCES "native_venue_deployment_releases"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_heads" ADD CONSTRAINT "native_heads_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_heads" ADD CONSTRAINT "native_heads_venue_fk" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_heads" ADD CONSTRAINT "native_heads_release_fk" FOREIGN KEY ("release_id","tenant_id","venue_id") REFERENCES "native_venue_deployment_releases"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_heads" ADD CONSTRAINT "native_heads_artifact_fk" FOREIGN KEY ("artifact_id","tenant_id","venue_id") REFERENCES "native_venue_deployment_artifacts"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_commands" ADD CONSTRAINT "native_commands_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_commands" ADD CONSTRAINT "native_commands_venue_fk" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_commands" ADD CONSTRAINT "native_commands_release_fk" FOREIGN KEY ("release_id","tenant_id","venue_id") REFERENCES "native_venue_deployment_releases"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION guard_native_venue_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'native venue deployment evidence is append-only';
END $$;
CREATE TRIGGER native_artifact_immutable BEFORE UPDATE OR DELETE ON "native_venue_deployment_artifacts" FOR EACH ROW EXECUTE FUNCTION guard_native_venue_immutable();
CREATE TRIGGER native_effect_immutable BEFORE UPDATE OR DELETE ON "native_venue_deployment_effects" FOR EACH ROW EXECUTE FUNCTION guard_native_venue_immutable();
CREATE TRIGGER native_command_immutable BEFORE UPDATE OR DELETE ON "native_venue_deployment_commands" FOR EACH ROW EXECUTE FUNCTION guard_native_venue_immutable();

CREATE FUNCTION guard_native_release_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native releases cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approved_command_id IS NOT NULL OR NEW.approved_command_hash IS NOT NULL OR NEW.applied_by IS NOT NULL OR NEW.applied_at IS NOT NULL OR NEW.applied_command_id IS NOT NULL OR NEW.applied_command_hash IS NOT NULL OR NEW.reverted_by IS NOT NULL OR NEW.reverted_at IS NOT NULL OR NEW.reverted_command_id IS NOT NULL OR NEW.reverted_command_hash IS NOT NULL THEN RAISE EXCEPTION 'native release must begin pristine DRAFT'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.venue_id,NEW.artifact_id,NEW.profile,NEW.manifest_hash,NEW.base_state_hash,NEW.desired_state_hash,NEW.plan_hash,NEW.expected_effect_count,NEW.replacement_universe,NEW.plan,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.venue_id,OLD.artifact_id,OLD.profile,OLD.manifest_hash,OLD.base_state_hash,OLD.desired_state_hash,OLD.plan_hash,OLD.expected_effect_count,OLD.replacement_universe,OLD.plan,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'native release plan is immutable'; END IF;
  IF NOT ((OLD.status='DRAFT' AND NEW.status='APPROVED' AND NEW.approved_by<>'' AND NEW.approved_at IS NOT NULL AND NEW.approved_command_id IS NOT NULL AND NEW.approved_command_hash ~ '^[a-f0-9]{64}$' AND NEW.updated_at=NEW.approved_at AND ROW(NEW.applied_by,NEW.applied_at,NEW.applied_command_id,NEW.applied_command_hash,NEW.reverted_by,NEW.reverted_at,NEW.reverted_command_id,NEW.reverted_command_hash) IS NOT DISTINCT FROM ROW(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL))
       OR (OLD.status='APPROVED' AND NEW.status='APPLIED' AND ROW(NEW.approved_by,NEW.approved_at,NEW.approved_command_id,NEW.approved_command_hash) IS NOT DISTINCT FROM ROW(OLD.approved_by,OLD.approved_at,OLD.approved_command_id,OLD.approved_command_hash) AND NEW.applied_by<>'' AND NEW.applied_at IS NOT NULL AND NEW.applied_command_id IS NOT NULL AND NEW.applied_command_hash ~ '^[a-f0-9]{64}$' AND NEW.updated_at=NEW.applied_at AND ROW(NEW.reverted_by,NEW.reverted_at,NEW.reverted_command_id,NEW.reverted_command_hash) IS NOT DISTINCT FROM ROW(NULL,NULL,NULL,NULL))
       OR (OLD.status='APPLIED' AND NEW.status='REVERTED' AND ROW(NEW.approved_by,NEW.approved_at,NEW.approved_command_id,NEW.approved_command_hash,NEW.applied_by,NEW.applied_at,NEW.applied_command_id,NEW.applied_command_hash) IS NOT DISTINCT FROM ROW(OLD.approved_by,OLD.approved_at,OLD.approved_command_id,OLD.approved_command_hash,OLD.applied_by,OLD.applied_at,OLD.applied_command_id,OLD.applied_command_hash) AND NEW.reverted_by<>'' AND NEW.reverted_at IS NOT NULL AND NEW.reverted_command_id IS NOT NULL AND NEW.reverted_command_hash ~ '^[a-f0-9]{64}$' AND NEW.updated_at=NEW.reverted_at)) THEN
    RAISE EXCEPTION 'invalid native release transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_release_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON "native_venue_deployment_releases" FOR EACH ROW EXECUTE FUNCTION guard_native_release_lifecycle();
CREATE TRIGGER native_release_no_delete BEFORE DELETE ON "native_venue_deployment_releases" FOR EACH ROW EXECUTE FUNCTION guard_native_venue_immutable();

CREATE FUNCTION guard_native_effect_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_order INTEGER; release_status "NativeVenueDeploymentReleaseStatus"; planned jsonb;
BEGIN
  SELECT status, plan->'effects'->(NEW.effect_order-1) INTO release_status, planned FROM native_venue_deployment_releases WHERE id=NEW.release_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id FOR UPDATE;
  IF release_status <> 'APPROVED' THEN RAISE EXCEPTION 'effects require an approved release'; END IF;
  SELECT COALESCE(MAX(effect_order),0)+1 INTO next_order FROM native_venue_deployment_effects WHERE release_id=NEW.release_id;
  IF NEW.effect_order <> next_order THEN RAISE EXCEPTION 'effect order must be contiguous'; END IF;
  IF planned IS NULL OR planned->>'effectOrder' IS DISTINCT FROM NEW.effect_order::text OR planned->>'kind' IS DISTINCT FROM NEW.kind::text OR planned->>'targetId' IS DISTINCT FROM NEW.target_id OR planned->>'beforeHash' IS DISTINCT FROM NEW.before_hash OR planned->>'afterHash' IS DISTINCT FROM NEW.after_hash OR planned->'beforeState' IS DISTINCT FROM NEW.before_state OR planned->'afterState' IS DISTINCT FROM NEW.after_state THEN RAISE EXCEPTION 'effect does not match immutable release plan'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_effect_insert BEFORE INSERT ON "native_venue_deployment_effects" FOR EACH ROW EXECUTE FUNCTION guard_native_effect_insert();

CREATE FUNCTION guard_native_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rel native_venue_deployment_releases%ROWTYPE;
BEGIN
  SELECT * INTO rel FROM native_venue_deployment_releases WHERE id=NEW.release_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
  IF rel.status <> 'APPLIED' OR NEW.artifact_id IS DISTINCT FROM rel.artifact_id OR NEW.manifest_hash IS DISTINCT FROM rel.manifest_hash OR NEW.state_hash IS DISTINCT FROM rel.desired_state_hash THEN RAISE EXCEPTION 'native head must match applied release'; END IF;
  IF TG_OP='UPDATE' AND NEW.revision <> OLD.revision+1 THEN RAISE EXCEPTION 'native head revision must advance exactly once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_head_guard BEFORE INSERT OR UPDATE ON "native_venue_deployment_heads" FOR EACH ROW EXECUTE FUNCTION guard_native_head();

-- Harden every evidence function against caller-controlled search paths.
ALTER FUNCTION guard_native_venue_immutable() SET search_path = pg_catalog, public;
ALTER FUNCTION guard_native_release_lifecycle() SET search_path = pg_catalog, public;
ALTER FUNCTION guard_native_effect_insert() SET search_path = pg_catalog, public;
ALTER FUNCTION guard_native_head() SET search_path = pg_catalog, public;

CREATE TRIGGER native_artifact_no_truncate BEFORE TRUNCATE ON "native_venue_deployment_artifacts" FOR EACH STATEMENT EXECUTE FUNCTION guard_native_venue_immutable();
CREATE TRIGGER native_release_no_truncate BEFORE TRUNCATE ON "native_venue_deployment_releases" FOR EACH STATEMENT EXECUTE FUNCTION guard_native_venue_immutable();
CREATE TRIGGER native_effect_no_truncate BEFORE TRUNCATE ON "native_venue_deployment_effects" FOR EACH STATEMENT EXECUTE FUNCTION guard_native_venue_immutable();
CREATE TRIGGER native_head_no_truncate BEFORE TRUNCATE ON "native_venue_deployment_heads" FOR EACH STATEMENT EXECUTE FUNCTION guard_native_venue_immutable();
CREATE TRIGGER native_command_no_truncate BEFORE TRUNCATE ON "native_venue_deployment_commands" FOR EACH STATEMENT EXECUTE FUNCTION guard_native_venue_immutable();

CREATE FUNCTION guard_native_artifact_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
  IF NEW.profile IS DISTINCT FROM 'NATIVE_CORE_V1' OR NEW.created_by IS NULL OR btrim(NEW.created_by)='' OR
     NEW.manifest_hash !~ '^[a-f0-9]{64}$' OR NEW.base_state_hash !~ '^[a-f0-9]{64}$' OR NEW.desired_state_hash !~ '^[a-f0-9]{64}$' OR
     jsonb_typeof(NEW.canonical_manifest) IS DISTINCT FROM 'object' OR
     jsonb_typeof(NEW.base_universe) IS DISTINCT FROM 'object' OR
     NEW.canonical_manifest->>'materializationProfile' IS DISTINCT FROM NEW.profile OR
     NEW.canonical_manifest->>'schemaVersion' IS DISTINCT FROM '2' OR
     NEW.canonical_manifest->>'packageType' IS DISTINCT FROM 'FULL' OR
     NEW.canonical_manifest->>'manifestId' IS DISTINCT FROM NEW.id::text OR
     NEW.canonical_manifest->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key::text OR
     NEW.canonical_manifest->>'venueRef' IS DISTINCT FROM NEW.venue_id OR
     NEW.canonical_manifest->'baseState'->>'stateHash' IS DISTINCT FROM NEW.base_state_hash OR
     NEW.canonical_manifest->'baseState' IS DISTINCT FROM NEW.base_universe
  THEN RAISE EXCEPTION 'native artifact scalar and canonical evidence disagree'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_artifact_insert_guard BEFORE INSERT ON "native_venue_deployment_artifacts" FOR EACH ROW EXECUTE FUNCTION guard_native_artifact_insert();

CREATE FUNCTION guard_native_release_artifact() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE artifact native_venue_deployment_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO artifact FROM public.native_venue_deployment_artifacts WHERE id=NEW.artifact_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
  IF NOT FOUND OR NEW.id IS DISTINCT FROM artifact.id OR NEW.profile IS DISTINCT FROM artifact.profile OR NEW.manifest_hash IS DISTINCT FROM artifact.manifest_hash OR NEW.base_state_hash IS DISTINCT FROM artifact.base_state_hash OR NEW.desired_state_hash IS DISTINCT FROM artifact.desired_state_hash OR NEW.replacement_universe IS DISTINCT FROM artifact.base_universe OR NEW.plan_hash !~ '^[a-f0-9]{64}$' OR NEW.expected_effect_count < 0 OR jsonb_typeof(NEW.plan->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.plan->'effects') IS DISTINCT FROM NEW.expected_effect_count THEN RAISE EXCEPTION 'native release and artifact evidence disagree'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_release_artifact_guard BEFORE INSERT OR UPDATE ON "native_venue_deployment_releases" FOR EACH ROW EXECUTE FUNCTION guard_native_release_artifact();

CREATE FUNCTION guard_native_effect_shape() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
  IF NEW.before_hash !~ '^[a-f0-9]{64}$' OR NEW.after_hash !~ '^[a-f0-9]{64}$' OR
     jsonb_typeof(NEW.before_state) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.after_state) IS DISTINCT FROM 'object' OR
     ARRAY(SELECT jsonb_object_keys(NEW.before_state) ORDER BY 1) IS DISTINCT FROM ARRAY['present','value'] OR
     ARRAY(SELECT jsonb_object_keys(NEW.after_state) ORDER BY 1) IS DISTINCT FROM ARRAY['present','value'] OR
     jsonb_typeof(NEW.before_state->'present') IS DISTINCT FROM 'boolean' OR jsonb_typeof(NEW.after_state->'present') IS DISTINCT FROM 'boolean' OR
     ((NEW.before_state->>'present')::boolean IS DISTINCT FROM (NEW.before_state->'value' IS DISTINCT FROM 'null'::jsonb)) OR
     ((NEW.after_state->>'present')::boolean IS DISTINCT FROM (NEW.after_state->'value' IS DISTINCT FROM 'null'::jsonb))
  THEN RAISE EXCEPTION 'native effect envelope is invalid'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_effect_shape_guard BEFORE INSERT ON "native_venue_deployment_effects" FOR EACH ROW EXECUTE FUNCTION guard_native_effect_shape();

CREATE FUNCTION validate_native_command_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE rel native_venue_deployment_releases%ROWTYPE; receipt native_venue_deployment_commands%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='native_venue_deployment_commands' THEN receipt:=NEW; SELECT * INTO rel FROM public.native_venue_deployment_releases WHERE id=NEW.release_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
  ELSE rel:=NEW; SELECT * INTO receipt FROM public.native_venue_deployment_commands WHERE id=CASE NEW.status WHEN 'APPROVED' THEN NEW.approved_command_id WHEN 'APPLIED' THEN NEW.applied_command_id WHEN 'REVERTED' THEN NEW.reverted_command_id END AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
  END IF;
  IF rel.status <> 'DRAFT' AND (NOT FOUND OR receipt.release_id IS DISTINCT FROM rel.id OR receipt.id IS DISTINCT FROM CASE receipt.kind WHEN 'APPROVE' THEN rel.approved_command_id WHEN 'APPLY' THEN rel.applied_command_id WHEN 'REVERT' THEN rel.reverted_command_id END OR receipt.produced_status::text IS DISTINCT FROM CASE receipt.kind WHEN 'APPROVE' THEN 'APPROVED' WHEN 'APPLY' THEN 'APPLIED' WHEN 'REVERT' THEN 'REVERTED' END OR receipt.actor_id IS DISTINCT FROM CASE receipt.kind WHEN 'APPROVE' THEN rel.approved_by WHEN 'APPLY' THEN rel.applied_by WHEN 'REVERT' THEN rel.reverted_by END OR receipt.command_hash IS DISTINCT FROM CASE receipt.kind WHEN 'APPROVE' THEN rel.approved_command_hash WHEN 'APPLY' THEN rel.applied_command_hash WHEN 'REVERT' THEN rel.reverted_command_hash END OR receipt.created_at IS DISTINCT FROM CASE receipt.kind WHEN 'APPROVE' THEN rel.approved_at WHEN 'APPLY' THEN rel.applied_at WHEN 'REVERT' THEN rel.reverted_at END) THEN RAISE EXCEPTION 'native command receipt and lifecycle tuple disagree'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_release_command_binding AFTER INSERT OR UPDATE ON "native_venue_deployment_releases" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_native_command_binding();
CREATE CONSTRAINT TRIGGER native_command_release_binding AFTER INSERT ON "native_venue_deployment_commands" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_native_command_binding();

CREATE FUNCTION guard_native_command_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN
  IF NEW.command_hash !~ '^[a-f0-9]{64}$' OR btrim(NEW.actor_id)='' OR jsonb_typeof(NEW.produced_snapshot) IS DISTINCT FROM 'object' OR NEW.produced_snapshot->>'releaseId' IS DISTINCT FROM NEW.release_id::text OR NEW.produced_snapshot->>'status' IS DISTINCT FROM NEW.produced_status::text OR (NEW.produced_snapshot->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'native command snapshot and scalar evidence disagree'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER native_command_insert_guard BEFORE INSERT ON "native_venue_deployment_commands" FOR EACH ROW EXECUTE FUNCTION guard_native_command_insert();

CREATE FUNCTION validate_native_effect_count() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ DECLARE actual integer; publication_effects integer; lineage_count integer; BEGIN
  IF NEW.status IN ('APPLIED','REVERTED') THEN SELECT count(*),count(*) FILTER (WHERE kind='GENERALIZED_PUBLICATION') INTO actual,publication_effects FROM public.native_venue_deployment_effects WHERE release_id=NEW.id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id; IF actual IS DISTINCT FROM NEW.expected_effect_count THEN RAISE EXCEPTION 'native effect set is incomplete'; END IF; SELECT count(*) INTO lineage_count FROM public.native_venue_deployment_publication_lineages l JOIN public.native_venue_deployment_effects e ON e.id=l.effect_id JOIN public.content_module_publications p ON p.id=l.publication_id AND p.tenant_id=l.tenant_id AND p.venue_id=l.venue_id AND p.request_id=l.request_id WHERE e.release_id=NEW.id AND l.phase=CASE WHEN NEW.status='APPLIED' THEN 'APPLY'::"NativeVenueDeploymentPublicationPhase" ELSE 'REVERT'::"NativeVenueDeploymentPublicationPhase" END AND p.actor_id IS NOT DISTINCT FROM CASE WHEN NEW.status='APPLIED' THEN NEW.applied_by ELSE NEW.reverted_by END; IF lineage_count IS DISTINCT FROM publication_effects THEN RAISE EXCEPTION 'native publication lineage set is incomplete'; END IF; END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_effect_count_complete AFTER UPDATE ON "native_venue_deployment_releases" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_native_effect_count();

CREATE OR REPLACE FUNCTION guard_native_head() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE rel public.native_venue_deployment_releases%ROWTYPE; prior jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO rel FROM public.native_venue_deployment_releases WHERE id=NEW.release_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
    IF rel.status<>'APPLIED' OR NEW.revision<>1 OR NEW.artifact_id IS DISTINCT FROM rel.artifact_id OR NEW.manifest_hash IS DISTINCT FROM rel.manifest_hash OR NEW.state_hash IS DISTINCT FROM rel.desired_state_hash THEN RAISE EXCEPTION 'native head must match first applied release'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NEW.release_id IS DISTINCT FROM OLD.release_id THEN
    SELECT * INTO rel FROM public.native_venue_deployment_releases WHERE id=NEW.release_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
    prior:=rel.plan->'priorHead';
    IF rel.status='APPLIED' AND prior IS NOT NULL AND prior IS DISTINCT FROM 'null'::jsonb AND prior->>'releaseId' IS NOT DISTINCT FROM OLD.release_id::text AND prior->>'artifactId' IS NOT DISTINCT FROM OLD.artifact_id::text AND prior->>'manifestHash' IS NOT DISTINCT FROM OLD.manifest_hash AND prior->>'stateHash' IS NOT DISTINCT FROM OLD.state_hash AND (prior->>'revision')::integer IS NOT DISTINCT FROM OLD.revision AND (prior->>'updatedAt')::timestamptz AT TIME ZONE 'UTC' IS NOT DISTINCT FROM OLD.updated_at AND NEW.artifact_id IS NOT DISTINCT FROM rel.artifact_id AND NEW.manifest_hash IS NOT DISTINCT FROM rel.manifest_hash AND NEW.state_hash IS NOT DISTINCT FROM rel.desired_state_hash AND NEW.revision=OLD.revision+1 THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO rel FROM public.native_venue_deployment_releases WHERE id=OLD.release_id AND tenant_id=OLD.tenant_id AND venue_id=OLD.venue_id;
  IF rel.status<>'REVERTED' OR NOT EXISTS (SELECT 1 FROM public.native_venue_deployment_commands c WHERE c.id=rel.reverted_command_id AND c.kind='REVERT' AND c.release_id=rel.id) THEN RAISE EXCEPTION 'native head reversal requires exact revert receipt'; END IF;
  prior:=rel.plan->'priorHead';
  IF TG_OP='DELETE' THEN IF prior IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'only first native head may be removed'; END IF; RETURN OLD; END IF;
  IF prior IS NULL OR prior='null'::jsonb OR NEW.release_id::text IS DISTINCT FROM prior->>'releaseId' OR NEW.artifact_id::text IS DISTINCT FROM prior->>'artifactId' OR NEW.manifest_hash IS DISTINCT FROM prior->>'manifestHash' OR NEW.state_hash IS DISTINCT FROM prior->>'stateHash' OR NEW.revision IS DISTINCT FROM OLD.revision+1 THEN RAISE EXCEPTION 'native prior head restoration mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_head_delete_guard BEFORE DELETE ON "native_venue_deployment_heads" FOR EACH ROW EXECUTE FUNCTION guard_native_head();

CREATE TYPE "NativeVenueDeploymentPublicationPhase" AS ENUM ('APPLY','REVERT');
CREATE TABLE "native_venue_deployment_publication_lineages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
  "effect_id" UUID NOT NULL, "phase" "NativeVenueDeploymentPublicationPhase" NOT NULL,
  "publication_id" TEXT NOT NULL UNIQUE, "request_id" UUID NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "native_venue_publication_lineages_effect_phase_key" ON "native_venue_deployment_publication_lineages"("effect_id","phase");
CREATE UNIQUE INDEX "native_venue_publication_lineages_publication_scope_key" ON "native_venue_deployment_publication_lineages"("publication_id","tenant_id","venue_id","request_id");
CREATE INDEX "native_venue_publication_lineages_scope_idx" ON "native_venue_deployment_publication_lineages"("tenant_id","venue_id","created_at");
ALTER TABLE "native_venue_deployment_publication_lineages" ADD CONSTRAINT "native_publication_lineage_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_publication_lineages" ADD CONSTRAINT "native_publication_lineage_venue_fk" FOREIGN KEY ("venue_id","tenant_id") REFERENCES "venues"("id","tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "native_venue_deployment_publication_lineages" ADD CONSTRAINT "native_publication_lineage_effect_fk" FOREIGN KEY ("effect_id","tenant_id","venue_id") REFERENCES "native_venue_deployment_effects"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "content_module_publications_native_scope_key" ON "content_module_publications"("id","tenant_id","venue_id","request_id");
ALTER TABLE "native_venue_deployment_publication_lineages" ADD CONSTRAINT "native_publication_lineage_publication_fk" FOREIGN KEY ("publication_id","tenant_id","venue_id","request_id") REFERENCES "content_module_publications"("id","tenant_id","venue_id","request_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION guard_native_publication_lineage() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE effect public.native_venue_deployment_effects%ROWTYPE; publication public.content_module_publications%ROWTYPE; expected_action text; expected_revision text; release_status "NativeVenueDeploymentReleaseStatus";
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'native publication lineage is append-only'; END IF;
  SELECT * INTO effect FROM public.native_venue_deployment_effects WHERE id=NEW.effect_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
  SELECT * INTO publication FROM public.content_module_publications WHERE id=NEW.publication_id;
  SELECT status INTO release_status FROM public.native_venue_deployment_releases WHERE id=effect.release_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id;
  IF (NEW.phase='APPLY' AND release_status<>'APPROVED') OR (NEW.phase='REVERT' AND release_status<>'APPLIED') THEN RAISE EXCEPTION 'native publication lineage phase disagrees with lifecycle'; END IF;
  IF effect.kind<>'GENERALIZED_PUBLICATION' OR publication.tenant_id IS DISTINCT FROM NEW.tenant_id OR publication.venue_id IS DISTINCT FROM NEW.venue_id OR publication.module_id IS DISTINCT FROM effect.target_id OR publication.request_id IS DISTINCT FROM NEW.request_id THEN RAISE EXCEPTION 'native publication lineage scope disagrees'; END IF;
  expected_action:=CASE WHEN NEW.phase='APPLY' THEN CASE WHEN (effect.after_state->>'present')::boolean THEN 'PUBLISH' ELSE 'WITHDRAW' END ELSE CASE WHEN (effect.before_state->>'present')::boolean THEN 'PUBLISH' ELSE 'WITHDRAW' END END;
  expected_revision:=CASE WHEN NEW.phase='APPLY' THEN COALESCE(effect.after_state->'value'->>'revisionId',effect.before_state->'value'->>'revisionId') ELSE COALESCE(effect.before_state->'value'->>'revisionId',effect.after_state->'value'->>'revisionId') END;
  IF publication.action::text IS DISTINCT FROM expected_action OR publication.revision_id IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'native publication lineage outcome disagrees'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_publication_lineage_guard BEFORE INSERT OR UPDATE OR DELETE ON "native_venue_deployment_publication_lineages" FOR EACH ROW EXECUTE FUNCTION guard_native_publication_lineage();
CREATE TRIGGER native_publication_lineage_no_truncate BEFORE TRUNCATE ON "native_venue_deployment_publication_lineages" FOR EACH STATEMENT EXECUTE FUNCTION guard_native_venue_immutable();
