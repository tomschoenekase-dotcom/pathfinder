CREATE TABLE "agent_question_operations" (
    "tenant_id" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "venue_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_question_operations_pkey" PRIMARY KEY ("tenant_id", "operation_id")
);

CREATE INDEX "agent_question_operations_question_scope_idx"
  ON "agent_question_operations"("tenant_id", "venue_id", "question_id");

ALTER TABLE "agent_question_operations"
  ADD CONSTRAINT "agent_question_operations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_question_operations"
  ADD CONSTRAINT "agent_question_operations_venue_scope_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "agent_question_operations"
  ADD CONSTRAINT "agent_question_operations_question_scope_fkey"
  FOREIGN KEY ("question_id", "tenant_id", "venue_id") REFERENCES "agent_questions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

INSERT INTO "agent_question_operations" ("tenant_id", "operation_id", "venue_id", "question_id", "created_at")
SELECT "tenant_id", "operation_id", "venue_id", "id", "created_at"
FROM "agent_questions";

CREATE FUNCTION "guard_agent_question_operation_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent question operation identity is immutable' USING ERRCODE = '55000';
END;
$$;

ALTER FUNCTION "guard_agent_question_operation_immutable"() SET search_path = pg_catalog, public;

CREATE TRIGGER "agent_question_operations_immutable"
  BEFORE UPDATE OR DELETE ON "agent_question_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_question_operation_immutable"();

CREATE TRIGGER "agent_question_operations_no_truncate"
  BEFORE TRUNCATE ON "agent_question_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_agent_question_operation_immutable"();
