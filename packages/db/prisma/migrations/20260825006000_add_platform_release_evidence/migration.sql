CREATE TABLE "platform_release_evidence" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "operation_hash" CHAR(64) NOT NULL,
  "evidence_hash" CHAR(64) NOT NULL,
  "revision" CHAR(40) NOT NULL,
  "profile" VARCHAR(32) NOT NULL,
  "readiness" VARCHAR(64) NOT NULL,
  "assessment_generated_at" TIMESTAMP(3) NOT NULL,
  "repository_clean" BOOLEAN NOT NULL,
  "passed" INTEGER NOT NULL,
  "failed" INTEGER NOT NULL,
  "blocked" INTEGER NOT NULL,
  "gates" JSONB NOT NULL,
  "limitations" JSONB NOT NULL,
  "rollback" JSONB NOT NULL,
  "staging_handoff" JSONB,
  "source_reference" VARCHAR(500) NOT NULL,
  "recorded_by_type" VARCHAR(20) NOT NULL,
  "recorded_by_id" VARCHAR(191) NOT NULL,
  "credential_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_release_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_release_evidence_counts_nonnegative" CHECK (
    "passed" >= 0 AND "failed" >= 0 AND "blocked" >= 0
  ),
  CONSTRAINT "platform_release_evidence_hashes_valid" CHECK (
    "operation_hash" ~ '^[0-9a-f]{64}$' AND
    "evidence_hash" ~ '^[0-9a-f]{64}$' AND
    "revision" ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT "platform_release_evidence_profile_valid" CHECK (
    "profile" IN ('local', 'candidate', 'staging')
  ),
  CONSTRAINT "platform_release_evidence_readiness_valid" CHECK (
    "readiness" IN ('ready-local', 'ready-for-staging-review', 'ready', 'not-ready')
  ),
  CONSTRAINT "platform_release_evidence_ready_is_green" CHECK (
    "readiness" = 'not-ready' OR
    ("repository_clean" = TRUE AND "failed" = 0 AND "blocked" = 0)
  ),
  CONSTRAINT "platform_release_evidence_actor_type" CHECK (
    "recorded_by_type" IN ('HUMAN', 'AGENT')
  ),
  CONSTRAINT "platform_release_evidence_agent_credential" CHECK (
    ("recorded_by_type" = 'AGENT' AND "credential_id" IS NOT NULL) OR
    ("recorded_by_type" = 'HUMAN' AND "credential_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "platform_release_evidence_operation_id_key"
  ON "platform_release_evidence"("operation_id");
CREATE UNIQUE INDEX "platform_release_evidence_evidence_hash_key"
  ON "platform_release_evidence"("evidence_hash");
CREATE INDEX "platform_release_evidence_revision_created_idx"
  ON "platform_release_evidence"("revision", "created_at");
CREATE INDEX "platform_release_evidence_readiness_created_idx"
  ON "platform_release_evidence"("readiness", "created_at");

ALTER TABLE "platform_release_evidence"
  ADD CONSTRAINT "platform_release_evidence_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "platform_worker_policy_credentials"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION guard_platform_release_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform release evidence is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "platform_release_evidence_immutable"
  BEFORE UPDATE OR DELETE ON "platform_release_evidence"
  FOR EACH ROW EXECUTE FUNCTION guard_platform_release_evidence_immutable();

CREATE TRIGGER "platform_release_evidence_no_truncate"
  BEFORE TRUNCATE ON "platform_release_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_release_evidence_immutable();
