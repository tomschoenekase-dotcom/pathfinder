CREATE TABLE "intake_v1_package_handoffs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "package_draft_id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "candidate_hash" CHAR(64) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "selected_member_ids" JSONB NOT NULL,
  "partial_acknowledged" BOOLEAN NOT NULL DEFAULT false,
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intake_v1_package_handoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "intake_v1_package_handoffs_revision_key" UNIQUE ("revision_id"),
  CONSTRAINT "intake_v1_package_handoffs_package_key" UNIQUE ("package_draft_id"),
  CONSTRAINT "intake_v1_package_handoffs_operation_key" UNIQUE ("tenant_id", "operation_id"),
  CONSTRAINT "intake_v1_package_handoffs_scope_key" UNIQUE ("id", "tenant_id", "venue_id"),
  CONSTRAINT "intake_v1_package_handoffs_manifest_hash_check" CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "intake_v1_package_handoffs_candidate_hash_check" CHECK ("candidate_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "intake_v1_package_handoffs_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "intake_v1_package_handoffs_selection_check" CHECK (
    jsonb_typeof("selected_member_ids") = 'array'
    AND jsonb_array_length("selected_member_ids") BETWEEN 1 AND 50
  ),
  CONSTRAINT "intake_v1_package_handoffs_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id") REFERENCES "intake_v1_submission_revisions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "intake_v1_package_handoffs_package_scope_fkey" FOREIGN KEY ("package_draft_id", "tenant_id", "venue_id") REFERENCES "venue_packages"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION pathfinder_guard_intake_v1_package_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'intake V1 package handoff is append-only'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM intake_v1_submission_revisions r
    WHERE r.id=NEW.revision_id AND r.tenant_id=NEW.tenant_id AND r.venue_id=NEW.venue_id AND r.manifest_hash=NEW.manifest_hash
  ) THEN RAISE EXCEPTION 'intake V1 handoff revision manifest does not match'; END IF;
  IF jsonb_typeof(NEW.selected_member_ids) <> 'array' THEN RAISE EXCEPTION 'intake V1 handoff selected members are invalid'; END IF;
  IF jsonb_array_length(NEW.selected_member_ids) NOT BETWEEN 1 AND 50 OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.selected_member_ids) AS item WHERE jsonb_typeof(item) <> 'string') THEN RAISE EXCEPTION 'intake V1 handoff selected members are invalid'; END IF;
  SELECT count(*) INTO member_count FROM jsonb_array_elements_text(NEW.selected_member_ids);
  IF member_count <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(NEW.selected_member_ids) AS value)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(NEW.selected_member_ids) AS selected(id)
      WHERE NOT EXISTS (SELECT 1 FROM intake_v1_submission_members m WHERE m.id=selected.id AND m.revision_id=NEW.revision_id AND m.tenant_id=NEW.tenant_id AND m.venue_id=NEW.venue_id)
    )
  THEN RAISE EXCEPTION 'intake V1 handoff selected members are invalid'; END IF;
  IF NOT NEW.partial_acknowledged AND (member_count <> (SELECT count(*) FROM intake_v1_submission_members WHERE revision_id=NEW.revision_id AND tenant_id=NEW.tenant_id AND venue_id=NEW.venue_id) OR EXISTS (SELECT 1 FROM intake_v1_submission_revisions WHERE id=NEW.revision_id AND jsonb_array_length(critical_missing)>0)) THEN RAISE EXCEPTION 'intake V1 handoff partial selection requires acknowledgement'; END IF;
  PERFORM p.id FROM venue_packages p WHERE p.id=NEW.package_draft_id AND p.tenant_id=NEW.tenant_id AND p.venue_id=NEW.venue_id
      AND p.status='DRAFT' AND p.payload_hash=NEW.payload_hash AND p.draft_key=NEW.operation_id AND p.created_by=NEW.created_by FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'intake V1 handoff package is not the exact DRAFT candidate'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intake_v1_package_handoffs_append_only BEFORE INSERT OR UPDATE OR DELETE ON "intake_v1_package_handoffs" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_intake_v1_package_handoff();
CREATE TRIGGER intake_v1_package_handoffs_no_truncate BEFORE TRUNCATE ON "intake_v1_package_handoffs" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_intake_v1_submission_evidence_mutation();