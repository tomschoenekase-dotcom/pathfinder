CREATE TYPE "FounderOperatingIntent" AS ENUM (
  'TOP_PRIORITY',
  'DECISIONS',
  'INCIDENTS',
  'AGENT_ACTIVITY',
  'CUSTOMER_ISSUES',
  'CHANGES',
  'COSTS',
  'DIRECTIVE'
);

CREATE TYPE "FounderOperatingDisposition" AS ENUM (
  'ANSWERED',
  'RECORDED_FOR_TRIAGE'
);

CREATE TABLE "founder_operating_exchanges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "operator_user_id" VARCHAR(191) NOT NULL,
  "prompt" VARCHAR(10000) NOT NULL,
  "intent" "FounderOperatingIntent" NOT NULL,
  "disposition" "FounderOperatingDisposition" NOT NULL,
  "response_title" VARCHAR(500) NOT NULL,
  "response_body" VARCHAR(10000) NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "snapshot" JSONB NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "founder_operating_exchanges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "founder_operating_exchanges_snapshot_hash_format_check"
    CHECK ("snapshot_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "founder_operating_exchanges_answer_boundary_check"
    CHECK (
      ("intent" = 'DIRECTIVE' AND "disposition" = 'RECORDED_FOR_TRIAGE')
      OR ("intent" <> 'DIRECTIVE' AND "disposition" = 'ANSWERED')
    )
);

CREATE UNIQUE INDEX "founder_operating_exchanges_operation_id_key"
  ON "founder_operating_exchanges"("operation_id");

CREATE UNIQUE INDEX "founder_operating_exchanges_snapshot_hash_key"
  ON "founder_operating_exchanges"("snapshot_hash");

CREATE INDEX "founder_operating_exchanges_created_idx"
  ON "founder_operating_exchanges"("created_at", "id");

CREATE INDEX "founder_operating_exchanges_intent_created_idx"
  ON "founder_operating_exchanges"("intent", "disposition", "created_at", "id");

CREATE TRIGGER "founder_operating_exchanges_append_only_update_delete"
  BEFORE UPDATE OR DELETE ON "founder_operating_exchanges"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

CREATE TRIGGER "founder_operating_exchanges_append_only_truncate"
  BEFORE TRUNCATE ON "founder_operating_exchanges"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
