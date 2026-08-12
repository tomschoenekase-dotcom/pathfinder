BEGIN;

-- Legacy participant operations remain nullable: their produced versions and
-- action timestamp were not durably recorded and must never be reconstructed.
ALTER TABLE "support_request_participants"
  ADD COLUMN "grant_request_version" INTEGER,
  ADD COLUMN "grant_client_version" INTEGER,
  ADD COLUMN "grant_action_at" TIMESTAMP(3),
  ADD COLUMN "revoke_request_version" INTEGER,
  ADD COLUMN "revoke_client_version" INTEGER,
  ADD COLUMN "revoke_action_at" TIMESTAMP(3),
  ADD CONSTRAINT "support_participant_grant_evidence_check" CHECK (
    ("grant_request_version" IS NULL AND "grant_client_version" IS NULL AND "grant_action_at" IS NULL)
    OR ("grant_request_version" > 0 AND "grant_client_version" > 0 AND "grant_action_at" = "granted_at")
  ),
  ADD CONSTRAINT "support_participant_revoke_evidence_check" CHECK (
    ("revoke_request_version" IS NULL AND "revoke_client_version" IS NULL AND "revoke_action_at" IS NULL)
    OR (
      "revoke_operation_id" IS NOT NULL AND "revoke_operation_hash" IS NOT NULL
      AND "revoke_request_version" > 0 AND "revoke_client_version" > 0 AND "revoke_action_at" = "revoked_at"
    )
  );

CREATE FUNCTION "preserve_support_participant_operation_evidence"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."grant_request_version" IS NULL OR NEW."grant_client_version" IS NULL
    OR NEW."grant_action_at" IS NULL OR NEW."grant_action_at" <> NEW."granted_at"
  ) THEN RAISE EXCEPTION 'new support participant requires complete grant evidence'; END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF (
    NEW."grant_request_version" IS DISTINCT FROM OLD."grant_request_version"
    OR NEW."grant_client_version" IS DISTINCT FROM OLD."grant_client_version"
    OR NEW."grant_action_at" IS DISTINCT FROM OLD."grant_action_at"
  ) THEN RAISE EXCEPTION 'support participant grant evidence is immutable'; END IF;
  IF OLD."revoke_request_version" IS NOT NULL AND (
    NEW."revoke_request_version" IS DISTINCT FROM OLD."revoke_request_version"
    OR NEW."revoke_client_version" IS DISTINCT FROM OLD."revoke_client_version"
    OR NEW."revoke_action_at" IS DISTINCT FROM OLD."revoke_action_at"
  ) THEN RAISE EXCEPTION 'support participant revoke evidence is immutable'; END IF;
  IF OLD."revoke_request_version" IS NULL AND NEW."revoke_request_version" IS NOT NULL AND NOT (
    OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL
    AND NEW."revoke_action_at" = NEW."revoked_at"
  ) THEN RAISE EXCEPTION 'support participant revoke evidence requires active revoke transition'; END IF;
  IF OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL AND (
    NEW."revoke_request_version" IS NULL OR NEW."revoke_client_version" IS NULL
    OR NEW."revoke_action_at" IS NULL OR NEW."revoke_action_at" <> NEW."revoked_at"
  ) THEN RAISE EXCEPTION 'support participant revoke requires complete evidence'; END IF;
  IF OLD."revoked_at" IS NOT NULL AND OLD."revoke_request_version" IS NULL AND (
    NEW."revoke_request_version" IS NOT NULL OR NEW."revoke_client_version" IS NOT NULL
    OR NEW."revoke_action_at" IS NOT NULL
  ) THEN RAISE EXCEPTION 'legacy revoked participant evidence remains unknown'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "support_participant_operation_evidence_immutable"
BEFORE INSERT OR UPDATE ON "support_request_participants"
FOR EACH ROW EXECUTE FUNCTION "preserve_support_participant_operation_evidence"();

ALTER TABLE "support_request_participants"
  ADD CONSTRAINT "support_participant_grant_audit_fk" FOREIGN KEY (
    "support_request_id", "tenant_id", "venue_id", "grant_request_version"
  ) REFERENCES "support_request_audit_events"("support_request_id", "tenant_id", "venue_id", "request_version") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "support_participant_revoke_audit_fk" FOREIGN KEY (
    "support_request_id", "tenant_id", "venue_id", "revoke_request_version"
  ) REFERENCES "support_request_audit_events"("support_request_id", "tenant_id", "venue_id", "request_version") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

COMMIT;
