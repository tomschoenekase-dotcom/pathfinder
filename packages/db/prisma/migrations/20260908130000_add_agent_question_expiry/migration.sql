ALTER TABLE "agent_questions"
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "expired_at" TIMESTAMP(3);

ALTER TABLE "agent_questions"
  DROP CONSTRAINT "agent_questions_answer_state_check";
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answer_state_check" CHECK (
  ("status" = 'PENDING' AND "answer" IS NULL AND "answered_by_id" IS NULL AND "answered_at" IS NULL AND "expired_at" IS NULL)
  OR ("status" IN ('ANSWERED', 'DISMISSED') AND "answer" IS NOT NULL AND "answered_by_id" IS NOT NULL AND "answered_at" IS NOT NULL AND "expired_at" IS NULL)
  OR ("status" = 'EXPIRED' AND "answer" IS NULL AND "answered_by_id" IS NULL AND "answered_at" IS NULL AND "expires_at" IS NOT NULL AND "expired_at" IS NOT NULL AND "expires_at" <= "expired_at")
  OR ("status" = 'CANCELLED' AND "answer" IS NULL AND "answered_by_id" IS NULL AND "answered_at" IS NULL AND "expired_at" IS NULL)
);

CREATE INDEX "agent_questions_status_expires_at_idx"
  ON "agent_questions"("status", "expires_at", "id");

CREATE FUNCTION pathfinder_guard_agent_question_expiry_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'PENDING' OR NEW."expired_at" IS NOT NULL THEN
    RAISE EXCEPTION 'new agent question must begin pending and unexpired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_questions_expiry_insert_guard"
  BEFORE INSERT ON "agent_questions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_agent_question_expiry_insert();

CREATE OR REPLACE FUNCTION pathfinder_guard_agent_question_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_questions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."venue_id" IS DISTINCT FROM OLD."venue_id"
    OR NEW."agent_identity_id" IS DISTINCT FROM OLD."agent_identity_id"
    OR NEW."agent_run_id" IS DISTINCT FROM OLD."agent_run_id"
    OR NEW."question" IS DISTINCT FROM OLD."question"
    OR NEW."context" IS DISTINCT FROM OLD."context"
    OR NEW."choices" IS DISTINCT FROM OLD."choices"
    OR NEW."blocking" IS DISTINCT FROM OLD."blocking"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'agent question request is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."expired_at" IS NOT NULL AND NEW."expired_at" IS DISTINCT FROM OLD."expired_at" THEN
    RAISE EXCEPTION 'agent question expiration evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (OLD."status" = 'PENDING' AND NEW."status" IN ('ANSWERED', 'DISMISSED', 'EXPIRED'))
  THEN
    RAISE EXCEPTION 'invalid agent question status transition' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'EXPIRED' THEN
    IF OLD."expires_at" IS NULL OR clock_timestamp() < OLD."expires_at" THEN
      RAISE EXCEPTION 'agent question expiration deadline has not arrived' USING ERRCODE = '23514';
    END IF;
    IF NEW."expired_at" IS NOT NULL THEN
      RAISE EXCEPTION 'agent question expiration timestamp is database assigned' USING ERRCODE = '23514';
    END IF;
    NEW."expired_at" := clock_timestamp();
  END IF;
  IF OLD."status" = 'PENDING'
    AND NEW."status" IN ('ANSWERED', 'DISMISSED')
    AND OLD."expires_at" IS NOT NULL
    AND clock_timestamp() >= OLD."expires_at"
  THEN
    RAISE EXCEPTION 'agent question answer deadline has expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pathfinder_guard_onboarding_question_link_expiry() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_questions" question
    WHERE question."id" = NEW."agent_question_id"
      AND question."tenant_id" = NEW."tenant_id"
      AND question."venue_id" = NEW."venue_id"
      AND (
        question."status" = 'EXPIRED'
        OR (question."expires_at" IS NOT NULL AND clock_timestamp() >= question."expires_at")
      )
  ) THEN
    RAISE EXCEPTION 'agent question answer deadline has expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "onboarding_question_links_expiry_guard"
  BEFORE INSERT ON "onboarding_question_links"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_onboarding_question_link_expiry();
