BEGIN;

CREATE TABLE "guest_answer_attributions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "guest_chat_turn_id" UUID NOT NULL,
  "schema_version" VARCHAR(64) NOT NULL,
  "answer_hash" CHAR(64) NOT NULL,
  "evidence_set_hash" CHAR(64) NOT NULL,
  "evaluator_provider" VARCHAR(100) NOT NULL,
  "evaluator_model" VARCHAR(191) NOT NULL,
  "evaluator_configuration" VARCHAR(191) NOT NULL,
  "evaluator_prompt_version" VARCHAR(191) NOT NULL,
  "attribution_snapshot" JSONB NOT NULL,
  "claim_count" INTEGER NOT NULL,
  "supported_count" INTEGER NOT NULL,
  "unsupported_count" INTEGER NOT NULL,
  "uncertain_count" INTEGER NOT NULL,
  "non_factual_count" INTEGER NOT NULL,
  "support_rate" DECIMAL(8,7),
  "actor_type" "ActorType" NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "guest_answer_attributions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guest_answer_attributions_operation_key"
  ON "guest_answer_attributions"("tenant_id", "operation_id");
CREATE UNIQUE INDEX "guest_answer_attributions_scope_key"
  ON "guest_answer_attributions"("id", "tenant_id", "venue_id");
CREATE INDEX "guest_answer_attributions_scope_created_idx"
  ON "guest_answer_attributions"("tenant_id", "venue_id", "created_at");
CREATE INDEX "guest_answer_attributions_turn_created_idx"
  ON "guest_answer_attributions"("tenant_id", "venue_id", "guest_chat_turn_id", "created_at");

ALTER TABLE "guest_answer_attributions"
  ADD CONSTRAINT "guest_answer_attributions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_answer_attributions"
  ADD CONSTRAINT "guest_answer_attributions_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_answer_attributions"
  ADD CONSTRAINT "guest_answer_attributions_session_scope_fkey"
  FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "guest_answer_attributions"
  ADD CONSTRAINT "guest_answer_attributions_turn_scope_fkey"
  FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id") REFERENCES "guest_chat_turns"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "guest_answer_attributions"
  ADD CONSTRAINT "guest_answer_attributions_counts_nonnegative_check"
  CHECK (
    "claim_count" >= 0 AND
    "supported_count" >= 0 AND
    "unsupported_count" >= 0 AND
    "uncertain_count" >= 0 AND
    "non_factual_count" >= 0 AND
    "claim_count" = "supported_count" + "unsupported_count" + "uncertain_count" + "non_factual_count"
  );
ALTER TABLE "guest_answer_attributions"
  ADD CONSTRAINT "guest_answer_attributions_support_rate_check"
  CHECK ("support_rate" IS NULL OR ("support_rate" >= 0 AND "support_rate" <= 1));

CREATE TRIGGER "guest_answer_attributions_append_only_update_delete"
  BEFORE UPDATE OR DELETE ON "guest_answer_attributions"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
CREATE TRIGGER "guest_answer_attributions_append_only_truncate"
  BEFORE TRUNCATE ON "guest_answer_attributions"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

COMMIT;
