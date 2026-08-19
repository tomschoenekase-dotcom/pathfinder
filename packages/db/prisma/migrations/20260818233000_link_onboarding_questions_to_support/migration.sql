BEGIN;

ALTER TABLE "agent_questions"
  ADD CONSTRAINT "agent_questions_id_tenant_venue_key"
  UNIQUE ("id", "tenant_id", "venue_id");

CREATE TABLE "onboarding_question_links" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "agent_question_id" TEXT NOT NULL,
  "expected_question_updated_at" TIMESTAMP(3) NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "recipient_user_id" VARCHAR(191) NOT NULL,
  "answered_support_message_id" TEXT,
  "resumed_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onboarding_question_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboarding_question_links_operation_hash_check"
    CHECK ("operation_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "onboarding_question_links_resume_pair_check"
    CHECK (("resumed_at" IS NULL) = ("answered_support_message_id" IS NULL)),
  CONSTRAINT "onboarding_question_links_actor_check"
    CHECK (char_length(btrim("recipient_user_id")) > 0 AND char_length(btrim("created_by")) > 0)
);

CREATE UNIQUE INDEX "onboarding_question_links_tenant_operation_key"
  ON "onboarding_question_links"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "onboarding_question_links_question_scope_key"
  ON "onboarding_question_links"("agent_question_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "onboarding_question_links_request_scope_key"
  ON "onboarding_question_links"("support_request_id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "onboarding_question_links_answer_message_key"
  ON "onboarding_question_links"("answered_support_message_id", "tenant_id", "venue_id", "support_request_id");
CREATE INDEX "onboarding_question_links_scope_resume_idx"
  ON "onboarding_question_links"("tenant_id", "venue_id", "resumed_at", "created_at");

ALTER TABLE "onboarding_question_links"
  ADD CONSTRAINT "onboarding_question_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "onboarding_question_links"
  ADD CONSTRAINT "onboarding_question_links_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "onboarding_question_links"
  ADD CONSTRAINT "onboarding_question_links_agent_question_scope_fkey"
  FOREIGN KEY ("agent_question_id", "tenant_id", "venue_id") REFERENCES "agent_questions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "onboarding_question_links"
  ADD CONSTRAINT "onboarding_question_links_support_request_scope_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "onboarding_question_links"
  ADD CONSTRAINT "onboarding_question_links_answer_message_scope_fkey"
  FOREIGN KEY ("answered_support_message_id", "tenant_id", "venue_id", "support_request_id") REFERENCES "support_messages"("id", "tenant_id", "venue_id", "support_request_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The originally assigned onboarding recipient may add or remove an active
-- teammate on this exact discussion. This is deliberately narrower than a
-- general participant delegation right and preserves the existing requester
-- behavior for ordinary client-created support requests.
CREATE OR REPLACE FUNCTION pathfinder_guard_support_request_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "tenant_memberships" membership
      WHERE membership."tenant_id" = NEW."tenant_id" AND membership."user_id" = NEW."user_id" AND membership."status" = 'ACTIVE'
    ) THEN RAISE EXCEPTION 'support participant must be an active tenant member'; END IF;
    IF EXISTS (
      SELECT 1 FROM "support_requests" request
      WHERE request."id" = NEW."support_request_id" AND request."tenant_id" = NEW."tenant_id" AND request."venue_id" = NEW."venue_id"
        AND request."requester_user_id" = NEW."user_id"
    ) THEN RAISE EXCEPTION 'support requester cannot be a participant'; END IF;
    IF NEW."granted_by_kind" = 'CLIENT' AND NOT (
      EXISTS (
        SELECT 1 FROM "support_requests" request
        WHERE request."id" = NEW."support_request_id" AND request."tenant_id" = NEW."tenant_id" AND request."venue_id" = NEW."venue_id"
          AND request."requester_user_id" = NEW."granted_by_id"
      ) OR EXISTS (
        SELECT 1
        FROM "onboarding_question_links" link
        JOIN "support_request_participants" manager
          ON manager."support_request_id" = link."support_request_id"
         AND manager."tenant_id" = link."tenant_id"
         AND manager."venue_id" = link."venue_id"
         AND manager."user_id" = link."recipient_user_id"
         AND manager."revoked_at" IS NULL
        WHERE link."support_request_id" = NEW."support_request_id"
          AND link."tenant_id" = NEW."tenant_id"
          AND link."venue_id" = NEW."venue_id"
          AND link."recipient_user_id" = NEW."granted_by_id"
      )
    ) THEN RAISE EXCEPTION 'only the requester or assigned onboarding recipient may grant client participant access'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'support participant evidence cannot be removed'; END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR OLD."venue_id" IS DISTINCT FROM NEW."venue_id" OR OLD."support_request_id" IS DISTINCT FROM NEW."support_request_id"
     OR OLD."user_id" IS DISTINCT FROM NEW."user_id" OR OLD."granted_by_kind" IS DISTINCT FROM NEW."granted_by_kind"
     OR OLD."grant_operation_id" IS DISTINCT FROM NEW."grant_operation_id" OR OLD."grant_operation_hash" IS DISTINCT FROM NEW."grant_operation_hash"
     OR OLD."granted_by_id" IS DISTINCT FROM NEW."granted_by_id" OR OLD."granted_at" IS DISTINCT FROM NEW."granted_at"
     OR OLD."revoked_at" IS NOT NULL THEN RAISE EXCEPTION 'support participant identity is immutable'; END IF;
  IF NEW."revoked_at" IS NULL THEN RAISE EXCEPTION 'support participant updates may only revoke access'; END IF;
  IF NEW."revoked_by_kind" = 'CLIENT' AND NOT (
    EXISTS (
      SELECT 1 FROM "support_requests" request
      WHERE request."id" = NEW."support_request_id" AND request."tenant_id" = NEW."tenant_id" AND request."venue_id" = NEW."venue_id"
        AND request."requester_user_id" = NEW."revoked_by_id"
    ) OR EXISTS (
      SELECT 1
      FROM "onboarding_question_links" link
      JOIN "support_request_participants" manager
        ON manager."support_request_id" = link."support_request_id"
       AND manager."tenant_id" = link."tenant_id"
       AND manager."venue_id" = link."venue_id"
       AND manager."user_id" = link."recipient_user_id"
       AND manager."revoked_at" IS NULL
      WHERE link."support_request_id" = NEW."support_request_id"
        AND link."tenant_id" = NEW."tenant_id"
        AND link."venue_id" = NEW."venue_id"
        AND link."recipient_user_id" = NEW."revoked_by_id"
    )
  ) THEN RAISE EXCEPTION 'only the requester or assigned onboarding recipient may revoke client participant access'; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
