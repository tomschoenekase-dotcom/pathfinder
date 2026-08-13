BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "visitor_sessions" s
    JOIN "venues" v ON v."id" = s."venue_id"
    WHERE s."tenant_id" <> v."tenant_id"
  ) THEN
    RAISE EXCEPTION 'legacy visitor session tenant/venue scope mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "messages" m
    JOIN "visitor_sessions" s ON s."id" = m."session_id"
    WHERE m."tenant_id" <> s."tenant_id"
  ) THEN
    RAISE EXCEPTION 'legacy message tenant/session scope mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "analytics_events" a
    LEFT JOIN "visitor_sessions" exact_session
      ON exact_session."id" = a."session_id"
     AND exact_session."tenant_id" = a."tenant_id"
     AND exact_session."venue_id" = a."venue_id"
    LEFT JOIN "visitor_sessions" token_session
      ON token_session."anonymous_token" = a."session_id"
     AND token_session."tenant_id" = a."tenant_id"
     AND token_session."venue_id" = a."venue_id"
    WHERE exact_session."id" IS NULL
      AND token_session."id" IS NULL
      AND NOT (a."event_type" = 'venue.updated' AND a."session_id" = '')
  ) THEN
    RAISE EXCEPTION 'legacy analytics event session scope is unresolved';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "engagement_question_responses" r
    JOIN "visitor_sessions" s ON s."id" = r."session_id"
    LEFT JOIN "messages" asked ON asked."id" = r."asked_message_id"
    LEFT JOIN "messages" answer ON answer."id" = r."answer_message_id"
    WHERE r."tenant_id" <> s."tenant_id"
       OR r."venue_id" <> s."venue_id"
       OR asked."id" IS NULL OR answer."id" IS NULL
       OR asked."role" <> 'assistant' OR answer."role" <> 'user'
       OR asked."session_id" <> r."session_id" OR answer."session_id" <> r."session_id"
       OR asked."tenant_id" <> r."tenant_id" OR answer."tenant_id" <> r."tenant_id"
  ) THEN
    RAISE EXCEPTION 'legacy engagement response scope/message mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "visitor_sessions" s
    LEFT JOIN "messages" asked ON asked."id" = s."pending_engagement_asked_message_id"
    WHERE NOT (
      (s."pending_engagement_question_id" IS NULL AND s."pending_engagement_is_invented" = FALSE
       AND s."pending_engagement_asked_message_id" IS NULL AND s."pending_engagement_asked_at" IS NULL)
      OR
      (s."pending_engagement_question_id" IS NOT NULL AND s."pending_engagement_is_invented" = FALSE
       AND s."pending_engagement_asked_message_id" IS NOT NULL AND s."pending_engagement_asked_at" IS NOT NULL)
      OR
      (s."pending_engagement_question_id" IS NULL AND s."pending_engagement_is_invented" = TRUE
       AND s."pending_engagement_asked_message_id" IS NOT NULL AND s."pending_engagement_asked_at" IS NOT NULL)
    )
    OR (s."pending_engagement_asked_message_id" IS NOT NULL AND (
      asked."id" IS NULL OR asked."tenant_id" <> s."tenant_id" OR asked."session_id" <> s."id"
      OR asked."role" <> 'assistant'
    ))
  ) THEN
    RAISE EXCEPTION 'legacy pending engagement state is invalid';
  END IF;
END;
$$;

CREATE TYPE "GuestChatTurnStatus" AS ENUM ('RESERVED', 'GENERATING', 'COMPLETE', 'FAILED', 'AMBIGUOUS');
CREATE TYPE "GuestChatProviderOperationKind" AS ENUM ('QUERY_EMBEDDING', 'RESPONSE_GENERATION');
CREATE TYPE "GuestChatProviderOperationStatus" AS ENUM ('RESERVED', 'DISPATCHED', 'OBSERVED', 'CANCELLED', 'TERMINAL_AMBIGUOUS');

ALTER TABLE "visitor_sessions"
  ADD COLUMN "next_turn_sequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_message_sequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "messages"
  ADD COLUMN "venue_id" TEXT,
  ADD COLUMN "guest_chat_turn_id" UUID,
  ADD COLUMN "session_sequence" INTEGER,
  ADD COLUMN "turn_message_sequence" INTEGER;
ALTER TABLE "engagement_question_responses" ADD COLUMN "guest_chat_turn_id" UUID;

-- Venue administration events historically used the empty string because the
-- analytics schema required a guest session even for non-guest activity. Keep
-- those events, but represent their lack of a visitor session truthfully before
-- adding the exact guest-session foreign key.
ALTER TABLE "analytics_events" ALTER COLUMN "session_id" DROP NOT NULL;
UPDATE "analytics_events"
SET "session_id" = NULL
WHERE "event_type" = 'venue.updated' AND "session_id" = '';

UPDATE "messages" m
SET "venue_id" = s."venue_id"
FROM "visitor_sessions" s
WHERE s."id" = m."session_id";

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "session_id" ORDER BY "created_at", "id")::INTEGER AS sequence
  FROM "messages"
)
UPDATE "messages" m SET "session_sequence" = numbered.sequence
FROM numbered WHERE numbered."id" = m."id";

UPDATE "visitor_sessions" s
SET "next_message_sequence" = COALESCE((
  SELECT MAX(m."session_sequence") FROM "messages" m WHERE m."session_id" = s."id"
), 0);

UPDATE "analytics_events" a
SET "session_id" = s."id"
FROM "visitor_sessions" s
WHERE a."session_id" = s."anonymous_token"
  AND a."tenant_id" = s."tenant_id"
  AND a."venue_id" = s."venue_id";

ALTER TABLE "messages" ALTER COLUMN "venue_id" SET NOT NULL;
ALTER TABLE "messages" ALTER COLUMN "session_sequence" SET NOT NULL;

CREATE UNIQUE INDEX "visitor_sessions_id_tenant_venue_key" ON "visitor_sessions"("id", "tenant_id", "venue_id");
ALTER TABLE "visitor_sessions" DROP CONSTRAINT "visitor_sessions_venue_id_fkey";
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_session_scope_fkey" FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "messages_id_scope_key" ON "messages"("id", "tenant_id", "venue_id", "session_id");
CREATE UNIQUE INDEX "messages_id_scope_turn_key" ON "messages"("id", "tenant_id", "venue_id", "session_id", "guest_chat_turn_id");
CREATE UNIQUE INDEX "messages_session_sequence_key" ON "messages"("session_id", "session_sequence");
CREATE UNIQUE INDEX "messages_turn_message_sequence_key" ON "messages"("guest_chat_turn_id", "turn_message_sequence");
CREATE UNIQUE INDEX "engagement_responses_answer_message_key" ON "engagement_question_responses"("answer_message_id");

CREATE TABLE "guest_chat_turns" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "request_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "turn_sequence" INTEGER NOT NULL,
  "user_message_sequence" INTEGER NOT NULL,
  "assistant_message_sequence" INTEGER NOT NULL,
  "status" "GuestChatTurnStatus" NOT NULL DEFAULT 'RESERVED',
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "claimed_at" TIMESTAMP(3),
  "user_message_id" TEXT,
  "assistant_message_id" TEXT,
  "replay_metadata" JSONB,
  "response_hash" CHAR(64),
  "fallback_code" VARCHAR(64),
  "failure_code" VARCHAR(64),
  "pending_question_id" TEXT,
  "pending_is_invented" BOOLEAN NOT NULL DEFAULT FALSE,
  "pending_asked_message_id" TEXT,
  "pending_asked_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "guest_chat_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guest_chat_turn_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "guest_chat_turn_lease_pair_check" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "guest_chat_turn_message_sequence_check" CHECK ("assistant_message_sequence" = "user_message_sequence" + 1),
  CONSTRAINT "guest_chat_turn_pending_shape_check" CHECK (
    ("pending_question_id" IS NULL AND "pending_is_invented" = FALSE AND "pending_asked_message_id" IS NULL AND "pending_asked_at" IS NULL)
    OR ("pending_question_id" IS NOT NULL AND "pending_is_invented" = FALSE AND "pending_asked_message_id" IS NOT NULL AND "pending_asked_at" IS NOT NULL)
    OR ("pending_question_id" IS NULL AND "pending_is_invented" = TRUE AND "pending_asked_message_id" IS NOT NULL AND "pending_asked_at" IS NOT NULL)
  ),
  CONSTRAINT "guest_chat_turn_terminal_shape_check" CHECK (
    ("status" = 'COMPLETE' AND "user_message_id" IS NOT NULL AND "assistant_message_id" IS NOT NULL
      AND "replay_metadata" IS NOT NULL AND "response_hash" IS NOT NULL AND "completed_at" IS NOT NULL
      AND "failure_code" IS NULL AND "failed_at" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" = 'FAILED' AND "user_message_id" IS NULL AND "assistant_message_id" IS NULL
      AND "replay_metadata" IS NULL AND "response_hash" IS NULL AND "completed_at" IS NULL
      AND "failure_code" IS NOT NULL AND "failed_at" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" = 'AMBIGUOUS' AND "user_message_id" IS NULL AND "assistant_message_id" IS NULL
      AND "replay_metadata" IS NULL AND "response_hash" IS NULL AND "completed_at" IS NULL
      AND "failure_code" IS NOT NULL AND "failed_at" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" IN ('RESERVED','GENERATING') AND "user_message_id" IS NULL AND "assistant_message_id" IS NULL
      AND "replay_metadata" IS NULL AND "response_hash" IS NULL AND "completed_at" IS NULL
      AND "failure_code" IS NULL AND "failed_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "guest_chat_turns_id_scope_key" ON "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id");
CREATE UNIQUE INDEX "guest_chat_turns_user_message_scope_key" ON "guest_chat_turns"("user_message_id", "tenant_id", "venue_id", "session_id", "id");
CREATE UNIQUE INDEX "guest_chat_turns_assistant_message_scope_key" ON "guest_chat_turns"("assistant_message_id", "tenant_id", "venue_id", "session_id", "id");
CREATE UNIQUE INDEX "guest_chat_turns_session_request_key" ON "guest_chat_turns"("session_id", "request_id");
CREATE UNIQUE INDEX "guest_chat_turns_session_sequence_key" ON "guest_chat_turns"("session_id", "turn_sequence");
CREATE UNIQUE INDEX "guest_chat_turns_one_active_per_session_key" ON "guest_chat_turns"("session_id") WHERE "status" IN ('RESERVED','GENERATING');
CREATE INDEX "guest_chat_turns_scope_created_idx" ON "guest_chat_turns"("tenant_id", "venue_id", "created_at");

CREATE TABLE "guest_chat_provider_operations" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "turn_id" UUID NOT NULL,
  "kind" "GuestChatProviderOperationKind" NOT NULL,
  "invocation_id" UUID NOT NULL,
  "status" "GuestChatProviderOperationStatus" NOT NULL DEFAULT 'RESERVED',
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "dispatched_at" TIMESTAMP(3),
  "observed_at" TIMESTAMP(3),
  "outcome_code" VARCHAR(64),
  "usage_reference" VARCHAR(191),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "guest_chat_provider_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "guest_chat_provider_operation_lease_pair_check" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "guest_chat_provider_operation_state_check" CHECK (
    ("status" = 'RESERVED' AND "dispatched_at" IS NULL AND "observed_at" IS NULL)
    OR ("status" = 'DISPATCHED' AND "dispatched_at" IS NOT NULL AND "observed_at" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" = 'OBSERVED' AND "dispatched_at" IS NOT NULL AND "observed_at" IS NOT NULL AND "outcome_code" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "dispatched_at" IS NULL AND "observed_at" IS NULL AND "outcome_code" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" = 'TERMINAL_AMBIGUOUS' AND "dispatched_at" IS NOT NULL AND "observed_at" IS NULL AND "outcome_code" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "guest_chat_provider_operations_turn_kind_key" ON "guest_chat_provider_operations"("turn_id", "kind");
CREATE UNIQUE INDEX "guest_chat_provider_operations_invocation_key" ON "guest_chat_provider_operations"("invocation_id");
CREATE INDEX "guest_chat_provider_operations_scope_created_idx" ON "guest_chat_provider_operations"("tenant_id", "venue_id", "created_at");

ALTER TABLE "guest_chat_turns" ADD CONSTRAINT "guest_chat_turns_session_scope_fkey" FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_chat_provider_operations" ADD CONSTRAINT "guest_chat_provider_operations_turn_scope_fkey" FOREIGN KEY ("turn_id", "tenant_id", "venue_id", "session_id") REFERENCES "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "messages" DROP CONSTRAINT "messages_session_id_fkey";
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_scope_fkey" FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_scope_fkey" FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id") REFERENCES "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_responses_turn_scope_fkey" FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id") REFERENCES "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_responses_asked_message_scope_fkey" FOREIGN KEY ("asked_message_id", "tenant_id", "venue_id", "session_id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_responses_answer_message_scope_fkey" FOREIGN KEY ("answer_message_id", "tenant_id", "venue_id", "session_id", "guest_chat_turn_id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id", "guest_chat_turn_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_pending_message_scope_fkey" FOREIGN KEY ("pending_engagement_asked_message_id", "tenant_id", "venue_id", "id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_chat_turns" ADD CONSTRAINT "guest_chat_turns_pending_message_scope_fkey" FOREIGN KEY ("pending_asked_message_id", "tenant_id", "venue_id", "session_id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_chat_turns" ADD CONSTRAINT "guest_chat_turns_user_message_scope_fkey" FOREIGN KEY ("user_message_id", "tenant_id", "venue_id", "session_id", "id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id", "guest_chat_turn_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_chat_turns" ADD CONSTRAINT "guest_chat_turns_assistant_message_scope_fkey" FOREIGN KEY ("assistant_message_id", "tenant_id", "venue_id", "session_id", "id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id", "guest_chat_turn_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_pair_shape_check" CHECK (
  ("guest_chat_turn_id" IS NULL AND "turn_message_sequence" IS NULL)
  OR ("guest_chat_turn_id" IS NOT NULL AND "turn_message_sequence" IN (0, 1))
);
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_response_turn_answer_check" CHECK ("guest_chat_turn_id" IS NULL OR "answer_message_id" IS NOT NULL);
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_pending_shape_check" CHECK (
  ("pending_engagement_question_id" IS NULL AND "pending_engagement_is_invented" = FALSE
    AND "pending_engagement_asked_message_id" IS NULL AND "pending_engagement_asked_at" IS NULL)
  OR ("pending_engagement_question_id" IS NOT NULL AND "pending_engagement_is_invented" = FALSE
    AND "pending_engagement_asked_message_id" IS NOT NULL AND "pending_engagement_asked_at" IS NOT NULL)
  OR ("pending_engagement_question_id" IS NULL AND "pending_engagement_is_invented" = TRUE
    AND "pending_engagement_asked_message_id" IS NOT NULL AND "pending_engagement_asked_at" IS NOT NULL)
);

CREATE FUNCTION pathfinder_guard_guest_chat_turn_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'guest chat turns are durable lifecycle evidence'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' OR NEW."lease_token" IS NOT NULL OR NEW."lease_expires_at" IS NOT NULL
       OR NEW."claimed_at" IS NOT NULL OR NEW."user_message_id" IS NOT NULL OR NEW."assistant_message_id" IS NOT NULL
       OR NEW."replay_metadata" IS NOT NULL OR NEW."response_hash" IS NOT NULL OR NEW."fallback_code" IS NOT NULL
       OR NEW."failure_code" IS NOT NULL OR NEW."completed_at" IS NOT NULL OR NEW."failed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'new guest chat turn must be a pristine reservation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" <> NEW."id" OR OLD."tenant_id" <> NEW."tenant_id" OR OLD."venue_id" <> NEW."venue_id"
     OR OLD."session_id" <> NEW."session_id" OR OLD."request_id" <> NEW."request_id"
     OR OLD."request_hash" <> NEW."request_hash" OR OLD."turn_sequence" <> NEW."turn_sequence"
     OR OLD."user_message_sequence" <> NEW."user_message_sequence"
     OR OLD."assistant_message_sequence" <> NEW."assistant_message_sequence"
     OR OLD."pending_question_id" IS DISTINCT FROM NEW."pending_question_id"
     OR OLD."pending_is_invented" IS DISTINCT FROM NEW."pending_is_invented"
     OR OLD."pending_asked_message_id" IS DISTINCT FROM NEW."pending_asked_message_id"
     OR OLD."pending_asked_at" IS DISTINCT FROM NEW."pending_asked_at"
     OR OLD."created_at" <> NEW."created_at" THEN
    RAISE EXCEPTION 'guest chat turn identity is immutable';
  END IF;
  IF OLD."status" IN ('COMPLETE','FAILED','AMBIGUOUS') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal guest chat turn evidence is immutable';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'RESERVED' AND NEW."status" IN ('GENERATING','FAILED'))
    OR (OLD."status" = 'GENERATING' AND NEW."status" IN ('COMPLETE','FAILED','AMBIGUOUS'))
  ) THEN RAISE EXCEPTION 'invalid guest chat turn transition'; END IF;
  IF OLD."status" = 'RESERVED' AND NEW."status" = 'GENERATING' AND (
    (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id") <> 2
    OR NOT EXISTS (SELECT 1 FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."kind" = 'QUERY_EMBEDDING' AND p."status" = 'RESERVED')
    OR NOT EXISTS (SELECT 1 FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."kind" = 'RESPONSE_GENERATION' AND p."status" = 'RESERVED')
  ) THEN RAISE EXCEPTION 'guest chat turn provider reservations are incomplete'; END IF;
  IF NEW."status" = 'COMPLETE' AND (
    NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."user_message_id" AND m."guest_chat_turn_id" = NEW."id" AND m."role" = 'user' AND m."turn_message_sequence" = 0 AND m."session_sequence" = NEW."user_message_sequence")
    OR NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."assistant_message_id" AND m."guest_chat_turn_id" = NEW."id" AND m."role" = 'assistant' AND m."turn_message_sequence" = 1 AND m."session_sequence" = NEW."assistant_message_sequence")
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" = 'OBSERVED') <> 2
  ) THEN RAISE EXCEPTION 'completed guest chat turn evidence is incomplete'; END IF;
  IF NEW."status" = 'FAILED' AND (
    (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id") <> 2
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" IN ('OBSERVED','CANCELLED')) <> 2
  ) THEN RAISE EXCEPTION 'failed guest chat turn provider evidence is not terminal'; END IF;
  IF NEW."status" = 'AMBIGUOUS' AND (
    (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id") <> 2
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" IN ('OBSERVED','CANCELLED','TERMINAL_AMBIGUOUS')) <> 2
    OR (SELECT COUNT(*) FROM "guest_chat_provider_operations" p WHERE p."turn_id" = NEW."id" AND p."status" IN ('OBSERVED','TERMINAL_AMBIGUOUS')) < 1
  ) THEN RAISE EXCEPTION 'ambiguous guest chat turn provider evidence is not terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_chat_turns_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON "guest_chat_turns" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_guest_chat_turn_mutation();
CREATE TRIGGER guest_chat_turns_no_truncate BEFORE TRUNCATE ON "guest_chat_turns" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_guest_chat_turn_mutation();

CREATE FUNCTION pathfinder_guard_guest_chat_provider_operation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'guest chat provider operations are durable evidence'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RESERVED' OR NEW."dispatched_at" IS NOT NULL OR NEW."observed_at" IS NOT NULL
       OR NEW."outcome_code" IS NOT NULL OR NEW."usage_reference" IS NOT NULL THEN
      RAISE EXCEPTION 'new guest chat provider operation must be reserved';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."id" <> NEW."id" OR OLD."tenant_id" <> NEW."tenant_id" OR OLD."venue_id" <> NEW."venue_id"
     OR OLD."session_id" <> NEW."session_id" OR OLD."turn_id" <> NEW."turn_id"
     OR OLD."kind" <> NEW."kind" OR OLD."invocation_id" <> NEW."invocation_id"
     OR OLD."created_at" <> NEW."created_at" THEN
    RAISE EXCEPTION 'guest chat provider operation identity is immutable';
  END IF;
  IF OLD."status" IN ('OBSERVED','CANCELLED','TERMINAL_AMBIGUOUS') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal guest chat provider operation evidence is immutable';
  END IF;
  IF OLD."status" <> NEW."status" AND NOT (
    (OLD."status" = 'RESERVED' AND NEW."status" = 'DISPATCHED')
    OR (OLD."status" = 'RESERVED' AND NEW."status" = 'CANCELLED')
    OR (OLD."status" = 'DISPATCHED' AND NEW."status" IN ('OBSERVED','TERMINAL_AMBIGUOUS'))
  ) THEN RAISE EXCEPTION 'invalid guest chat provider operation transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_chat_provider_operations_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON "guest_chat_provider_operations" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_guest_chat_provider_operation_mutation();
CREATE TRIGGER guest_chat_provider_operations_no_truncate BEFORE TRUNCATE ON "guest_chat_provider_operations" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_guest_chat_provider_operation_mutation();

CREATE FUNCTION pathfinder_guard_visitor_session_pending_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pending_engagement_asked_message_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "messages" m
    WHERE m."id" = NEW."pending_engagement_asked_message_id"
      AND m."tenant_id" = NEW."tenant_id" AND m."venue_id" = NEW."venue_id"
      AND m."session_id" = NEW."id" AND m."role" = 'assistant'
  ) THEN RAISE EXCEPTION 'pending engagement asked message must be assistant'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visitor_sessions_pending_role_guard BEFORE INSERT OR UPDATE OF "pending_engagement_asked_message_id" ON "visitor_sessions" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_visitor_session_pending_role();

CREATE FUNCTION pathfinder_guard_guest_chat_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'guest chat messages are durable evidence'; END IF;
  IF TG_OP = 'DELETE' AND OLD."guest_chat_turn_id" IS NOT NULL THEN RAISE EXCEPTION 'guest chat messages are durable evidence'; END IF;
  IF TG_OP = 'UPDATE' AND OLD."guest_chat_turn_id" IS NOT NULL AND (
    OLD."id" IS DISTINCT FROM NEW."id" OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
    OR OLD."venue_id" IS DISTINCT FROM NEW."venue_id" OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
    OR OLD."guest_chat_turn_id" IS DISTINCT FROM NEW."guest_chat_turn_id"
    OR OLD."session_sequence" IS DISTINCT FROM NEW."session_sequence"
    OR OLD."turn_message_sequence" IS DISTINCT FROM NEW."turn_message_sequence"
    OR OLD."role" IS DISTINCT FROM NEW."role" OR OLD."content" IS DISTINCT FROM NEW."content"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  ) THEN RAISE EXCEPTION 'guest chat message identity/content is immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER messages_guest_chat_guard BEFORE UPDATE OR DELETE ON "messages" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_guest_chat_message_mutation();
CREATE TRIGGER messages_guest_chat_no_truncate BEFORE TRUNCATE ON "messages" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_guest_chat_message_mutation();

CREATE FUNCTION pathfinder_guard_guest_chat_engagement_response_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'guest chat engagement responses are durable evidence'; END IF;
  IF TG_OP = 'INSERT' AND NEW."guest_chat_turn_id" IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."asked_message_id" AND m."tenant_id" = NEW."tenant_id" AND m."venue_id" = NEW."venue_id" AND m."session_id" = NEW."session_id" AND m."role" = 'assistant')
    OR NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."answer_message_id" AND m."tenant_id" = NEW."tenant_id" AND m."venue_id" = NEW."venue_id" AND m."session_id" = NEW."session_id" AND m."role" = 'user')
  ) THEN RAISE EXCEPTION 'guest chat engagement message roles are invalid'; END IF;
  IF OLD."guest_chat_turn_id" IS NOT NULL THEN RAISE EXCEPTION 'guest chat engagement responses are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER engagement_responses_guest_chat_guard BEFORE INSERT OR UPDATE OR DELETE ON "engagement_question_responses" FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_guest_chat_engagement_response_mutation();
CREATE TRIGGER engagement_responses_guest_chat_no_truncate BEFORE TRUNCATE ON "engagement_question_responses" FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_guest_chat_engagement_response_mutation();

COMMIT;
