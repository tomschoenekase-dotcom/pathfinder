-- A single deferred trigger function serves both offboarding_plans and
-- offboarding_export_operations. Compare the polymorphic record status as text so
-- PostgreSQL does not bind SETTLED to OffboardingPlanStatus when the first invocation
-- comes from an offboarding plan insert.
CREATE OR REPLACE FUNCTION pathfinder_validate_offboarding_export_audits() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE audit public.audit_logs%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'offboarding_plans' AND NEW.status::text = 'REVIEWED' THEN
    SELECT * INTO audit FROM public.audit_logs WHERE id = NEW.export_review_audit_id;
    IF NOT FOUND OR audit.tenant_id IS DISTINCT FROM NEW.tenant_id OR audit.actor_id IS DISTINCT FROM NEW.export_reviewed_by
      OR audit.actor_role IS DISTINCT FROM 'PLATFORM_ADMIN' OR audit.action IS DISTINCT FROM 'offboarding-plan.export-reviewed'
      OR audit.target_type IS DISTINCT FROM 'OffboardingPlan' OR audit.target_id IS DISTINCT FROM NEW.id
      OR audit.created_at IS DISTINCT FROM NEW.export_reviewed_at OR audit.before_state IS DISTINCT FROM '{"status":"REQUESTED"}'::jsonb
      OR audit.after_state->>'status' IS DISTINCT FROM 'REVIEWED'
      OR audit.after_state->'exportKinds' IS DISTINCT FROM to_jsonb(NEW.export_kinds)
      OR (audit.after_state->>'venueCount')::integer IS DISTINCT FROM (SELECT count(*)::integer FROM public.offboarding_venue_targets t WHERE t.tenant_id=NEW.tenant_id AND t.plan_id=NEW.id)
      THEN RAISE EXCEPTION 'offboarding review audit mismatch'; END IF;
  ELSIF TG_TABLE_NAME = 'offboarding_export_operations' AND NEW.status::text = 'SETTLED' THEN
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
