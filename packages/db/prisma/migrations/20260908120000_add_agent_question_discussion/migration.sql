CREATE TABLE "agent_question_discussion_messages" (
  "id" TEXT NOT NULL,
  "operation_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "question_id" TEXT NOT NULL,
  "author_id" VARCHAR(191) NOT NULL,
  "body" VARCHAR(5000) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_question_discussion_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_question_discussion_messages_body_check" CHECK ("body" ~ '[^[:space:]]' AND char_length("body") <= 5000)
);

CREATE UNIQUE INDEX "agent_question_discussion_messages_tenant_operation_key"
  ON "agent_question_discussion_messages"("tenant_id", "operation_id");
CREATE INDEX "agent_question_discussion_messages_scope_created_idx"
  ON "agent_question_discussion_messages"("tenant_id", "venue_id", "question_id", "created_at", "id");

ALTER TABLE "agent_question_discussion_messages"
  ADD CONSTRAINT "agent_question_discussion_messages_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_question_discussion_messages_venue_id_tenant_id_fkey"
    FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "agent_question_discussion_messages_question_scope_fkey"
    FOREIGN KEY ("question_id", "tenant_id", "venue_id") REFERENCES "agent_questions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_agent_question_discussion_message_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent question discussion messages are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_question_discussion_messages_no_mutation"
  BEFORE UPDATE OR DELETE ON "agent_question_discussion_messages"
  FOR EACH ROW EXECUTE FUNCTION reject_agent_question_discussion_message_mutation();
CREATE TRIGGER "agent_question_discussion_messages_no_truncate"
  BEFORE TRUNCATE ON "agent_question_discussion_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_question_discussion_message_mutation();
