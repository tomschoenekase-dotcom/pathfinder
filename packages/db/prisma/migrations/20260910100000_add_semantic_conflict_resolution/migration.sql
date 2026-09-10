CREATE TABLE "semantic_conflict_resolutions" (
 "id" UUID PRIMARY KEY, "tenant_id" TEXT NOT NULL, "venue_id" TEXT NOT NULL,
 "proposal_id" UUID NOT NULL, "proposal_updated_at" TIMESTAMP(3) NOT NULL,
 "preview_hash" CHAR(64) NOT NULL, "question_id" TEXT NOT NULL,
 "question_updated_at" TIMESTAMP(3) NOT NULL, "answered_at" TIMESTAMP(3) NOT NULL,
 "answer_hash" CHAR(64) NOT NULL, "target_knowledge_entry_id" TEXT NOT NULL,
 "target_snapshot_hash" CHAR(64) NOT NULL, "input_hash" CHAR(64) NOT NULL,
 "relation" VARCHAR(16) NOT NULL, "conflict_desired" JSONB NOT NULL, "desired" JSONB NOT NULL,
 "outcome" VARCHAR(24) NOT NULL, "resolution_note" VARCHAR(2000) NOT NULL,
 "replacement_proposal_id" UUID, "created_by" VARCHAR(191) NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "semantic_conflict_resolution_hash_check" CHECK (
  "preview_hash" ~ '^[a-f0-9]{64}$' AND "answer_hash" ~ '^[a-f0-9]{64}$'
  AND "target_snapshot_hash" ~ '^[a-f0-9]{64}$' AND "input_hash" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "semantic_conflict_resolution_shape_check" CHECK (
  "relation" IN ('CORRECTS','SUPERSEDES') AND jsonb_typeof("desired")='object' AND jsonb_typeof("conflict_desired")='object'
  AND length(btrim("resolution_note")) > 0 AND length(btrim("created_by")) > 0
  AND (("outcome"='KEEP_CANONICAL' AND "replacement_proposal_id" IS NULL)
    OR ("outcome"='PROPOSE_REPLACEMENT' AND "replacement_proposal_id" IS NOT NULL))
  AND "replacement_proposal_id" IS DISTINCT FROM "proposal_id"),
 CONSTRAINT "semantic_conflict_resolution_proposal_fkey" FOREIGN KEY ("proposal_id","tenant_id","venue_id") REFERENCES "knowledge_change_proposals"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "semantic_conflict_resolution_replacement_fkey" FOREIGN KEY ("replacement_proposal_id","tenant_id","venue_id") REFERENCES "knowledge_change_proposals"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "semantic_conflict_resolution_question_fkey" FOREIGN KEY ("question_id","tenant_id","venue_id") REFERENCES "agent_questions"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "semantic_conflict_resolution_target_fkey" FOREIGN KEY ("target_knowledge_entry_id","tenant_id","venue_id") REFERENCES "venue_knowledge_entries"("id","tenant_id","venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "semantic_conflict_resolution_question_key" ON "semantic_conflict_resolutions"("question_id","tenant_id","venue_id");
CREATE UNIQUE INDEX "semantic_conflict_resolution_replacement_key" ON "semantic_conflict_resolutions"("replacement_proposal_id","tenant_id","venue_id");
CREATE INDEX "semantic_conflict_resolution_scope_idx" ON "semantic_conflict_resolutions"("tenant_id","venue_id","proposal_id");
CREATE FUNCTION guard_semantic_conflict_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Semantic conflict resolutions are append-only'; END IF;
 PERFORM 1 FROM "knowledge_change_proposals" p WHERE p.id=NEW.proposal_id AND p.tenant_id=NEW.tenant_id AND p.venue_id=NEW.venue_id
  AND p.status='APPROVED' AND p.updated_at=NEW.proposal_updated_at AND p.target_knowledge_entry_id=NEW.target_knowledge_entry_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Resolution requires the exact approved targeted proposal'; END IF;
 PERFORM 1 FROM "agent_questions" q WHERE q.id=NEW.question_id AND q.tenant_id=NEW.tenant_id AND q.venue_id=NEW.venue_id
  AND q.status='ANSWERED' AND q.updated_at=NEW.question_updated_at AND q.answered_at=NEW.answered_at
  AND q.answered_by_id IS NOT NULL AND q.answer IS NOT NULL
  AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(q.answer,'UTF8')),'hex')=NEW.answer_hash
  AND q.callback_metadata->>'workflow'='semantic-venue-update'
  AND q.callback_metadata->>'proposalId'=NEW.proposal_id::text
  AND q.callback_metadata->>'previewHash'=NEW.preview_hash
  AND q.callback_metadata->>'classification'='CONFLICT' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Resolution requires the exact answered semantic question'; END IF;
 IF NEW.replacement_proposal_id IS NOT NULL THEN
  PERFORM 1 FROM "knowledge_change_proposals" p WHERE p.id=NEW.replacement_proposal_id AND p.tenant_id=NEW.tenant_id AND p.venue_id=NEW.venue_id
   AND p.status='PENDING_REVIEW' AND p.created_by_type='HUMAN' AND p.created_by_id=NEW.created_by
   AND p.proposed_change=NEW.desired->>'content'
   AND p.target_knowledge_entry_id=NEW.target_knowledge_entry_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resolution replacement must be an unapproved human proposal in the exact scope'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "semantic_conflict_resolution_guard" BEFORE INSERT OR UPDATE OR DELETE ON "semantic_conflict_resolutions"
 FOR EACH ROW EXECUTE FUNCTION guard_semantic_conflict_resolution();
