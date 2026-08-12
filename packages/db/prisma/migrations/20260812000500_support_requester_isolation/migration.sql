BEGIN;

ALTER TABLE "support_requests"
  ADD COLUMN "requester_user_id" TEXT,
  ADD COLUMN "client_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "client_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "support_messages"
  ADD COLUMN "client_version" INTEGER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "support_requests" request
    LEFT JOIN "tenant_memberships" membership
      ON membership."tenant_id" = request."tenant_id"
     AND membership."user_id" = request."created_by_id"
    WHERE request."created_by_kind" = 'CLIENT'
      AND (char_length(btrim(request."created_by_id")) = 0 OR membership."id" IS NULL)
  ) THEN
    RAISE EXCEPTION 'client support requester does not resolve to an exact tenant membership';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "support_preview_feedback" feedback
    JOIN "support_requests" request
      ON request."id" = feedback."support_request_id"
     AND request."tenant_id" = feedback."tenant_id"
     AND request."venue_id" = feedback."venue_id"
    WHERE request."created_by_kind" <> 'CLIENT'
       OR request."created_by_id" <> feedback."created_by_id"
  ) THEN
    RAISE EXCEPTION 'preview feedback requester identity does not match its support request';
  END IF;
END;
$$;

UPDATE "support_requests"
SET "requester_user_id" = "created_by_id"
WHERE "created_by_kind" = 'CLIENT';

WITH client_activity AS (
  SELECT request."id" AS request_id,
         GREATEST(1, COUNT(message."id"))::INTEGER AS client_version,
         COALESCE(MAX(message."created_at"), request."created_at") AS client_activity_at
  FROM "support_requests" request
  LEFT JOIN "support_messages" message
    ON message."support_request_id" = request."id"
   AND message."tenant_id" = request."tenant_id"
   AND message."venue_id" = request."venue_id"
   AND message."visibility" = 'CLIENT_VISIBLE'
  GROUP BY request."id", request."created_at"
)
UPDATE "support_requests" request
SET "client_version" = activity.client_version,
    "client_activity_at" = activity.client_activity_at
FROM client_activity activity
WHERE request."id" = activity.request_id;

-- The legacy append-only trigger is removed only inside this migration transaction
-- so the deterministic version backfill can run, then restored before commit.
DROP TRIGGER "support_messages_append_only" ON "support_messages";
WITH visible_message_versions AS (
  SELECT message."id",
         ROW_NUMBER() OVER (
           PARTITION BY message."tenant_id", message."venue_id", message."support_request_id"
           ORDER BY message."created_at", message."id"
         )::INTEGER AS client_version
  FROM "support_messages" message
  WHERE message."visibility" = 'CLIENT_VISIBLE'
)
UPDATE "support_messages" message
SET "client_version" = version.client_version
FROM visible_message_versions version
WHERE message."id" = version."id";
CREATE TRIGGER "support_messages_append_only"
  BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION "pathfinder_reject_support_evidence_mutation"();

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_client_version_shape_check"
  CHECK (("visibility" = 'CLIENT_VISIBLE' AND "client_version" IS NOT NULL AND "client_version" > 0)
      OR ("visibility" <> 'CLIENT_VISIBLE' AND "client_version" IS NULL));
CREATE UNIQUE INDEX "support_messages_request_client_version_key"
  ON "support_messages"("support_request_id", "tenant_id", "venue_id", "client_version")
  WHERE "client_version" IS NOT NULL;

ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_requester_shape_check"
  CHECK (("created_by_kind" = 'CLIENT' AND "requester_user_id" IS NOT NULL)
      OR ("created_by_kind" <> 'CLIENT' AND "requester_user_id" IS NULL));
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_client_version_check"
  CHECK ("client_version" > 0);
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_requester_membership_fkey"
  FOREIGN KEY ("tenant_id", "requester_user_id") REFERENCES "tenant_memberships"("tenant_id", "user_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "support_request_participants" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "support_request_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "grant_operation_id" UUID NOT NULL,
  "grant_operation_hash" CHAR(64) NOT NULL,
  "granted_by_kind" "SupportParticipantKind" NOT NULL,
  "granted_by_id" VARCHAR(191) NOT NULL,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "revoked_by_kind" "SupportParticipantKind",
  "revoked_by_id" VARCHAR(191),
  "revoke_operation_id" UUID,
  "revoke_operation_hash" CHAR(64),
  CONSTRAINT "support_request_participants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_request_participants_grant_hash_check" CHECK ("grant_operation_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "support_request_participants_grantor_check" CHECK ("granted_by_kind" IN ('CLIENT', 'OPERATOR')),
  CONSTRAINT "support_request_participants_revocation_shape_check" CHECK (
    ("revoked_at" IS NULL AND "revoked_by_kind" IS NULL AND "revoked_by_id" IS NULL AND "revoke_operation_id" IS NULL AND "revoke_operation_hash" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by_kind" IN ('CLIENT', 'OPERATOR') AND "revoked_by_id" IS NOT NULL AND "revoke_operation_id" IS NOT NULL AND "revoke_operation_hash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX "support_request_participants_active_user_key"
  ON "support_request_participants"("support_request_id", "tenant_id", "venue_id", "user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "support_request_participants_grant_operation_key" ON "support_request_participants"("tenant_id", "grant_operation_id");
CREATE UNIQUE INDEX "support_request_participants_revoke_operation_key" ON "support_request_participants"("tenant_id", "revoke_operation_id");
CREATE INDEX "support_request_participants_user_active_idx"
  ON "support_request_participants"("tenant_id", "user_id", "revoked_at", "support_request_id");
CREATE INDEX "support_requests_requester_activity_idx"
  ON "support_requests"("tenant_id", "venue_id", "requester_user_id", "client_activity_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "support_requests_requester_updated_idx"
  ON "support_requests"("tenant_id", "venue_id", "created_by_kind", "created_by_id", "updated_at", "id");

ALTER TABLE "support_request_participants" ADD CONSTRAINT "support_request_participants_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_request_participants" ADD CONSTRAINT "support_request_participants_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_request_participants" ADD CONSTRAINT "support_request_participants_request_scope_fkey"
  FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "support_request_participants" ADD CONSTRAINT "support_request_participants_membership_fkey"
  FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_support_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'support request identity cannot be removed'; END IF;
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR OLD."venue_id" IS DISTINCT FROM NEW."venue_id"
     OR OLD."created_by_kind" IS DISTINCT FROM NEW."created_by_kind"
     OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
     OR OLD."requester_user_id" IS DISTINCT FROM NEW."requester_user_id"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'support request requester identity is immutable';
  END IF;
  IF NEW."client_version" < OLD."client_version" OR NEW."client_activity_at" < OLD."client_activity_at" THEN
    RAISE EXCEPTION 'support request client activity cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER support_requests_identity_immutable BEFORE UPDATE OR DELETE ON "support_requests"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_support_request_identity();
CREATE TRIGGER support_requests_no_truncate BEFORE TRUNCATE ON "support_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_support_request_identity();

CREATE FUNCTION pathfinder_guard_support_request_participant() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW."granted_by_kind" = 'CLIENT' AND NOT EXISTS (
      SELECT 1 FROM "support_requests" request
      WHERE request."id" = NEW."support_request_id" AND request."tenant_id" = NEW."tenant_id" AND request."venue_id" = NEW."venue_id"
        AND request."requester_user_id" = NEW."granted_by_id"
    ) THEN RAISE EXCEPTION 'only the requester may grant client participant access'; END IF;
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
  IF NEW."revoked_by_kind" = 'CLIENT' AND NOT EXISTS (
    SELECT 1 FROM "support_requests" request
    WHERE request."id" = NEW."support_request_id" AND request."tenant_id" = NEW."tenant_id" AND request."venue_id" = NEW."venue_id"
      AND request."requester_user_id" = NEW."revoked_by_id"
  ) THEN RAISE EXCEPTION 'only the requester may revoke client participant access'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER support_request_participants_guard BEFORE INSERT OR UPDATE OR DELETE ON "support_request_participants"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_guard_support_request_participant();
CREATE TRIGGER support_request_participants_no_truncate BEFORE TRUNCATE ON "support_request_participants"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_guard_support_request_participant();

COMMIT;
