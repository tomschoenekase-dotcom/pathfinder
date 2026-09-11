ALTER TABLE "agent_outcome_observations"
  ADD COLUMN "source_question_id" TEXT,
  ADD COLUMN "source_question_updated_at" TIMESTAMP(3),
  ADD COLUMN "source_answered_at" TIMESTAMP(3),
  ADD COLUMN "source_answer_sha256" CHAR(64);

ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_source_question_provenance_check" CHECK (
    (
      "source_question_id" IS NULL
      AND "source_question_updated_at" IS NULL
      AND "source_answered_at" IS NULL
      AND "source_answer_sha256" IS NULL
    ) OR (
      "source_question_id" IS NOT NULL
      AND "source_question_updated_at" IS NOT NULL
      AND "source_answered_at" IS NOT NULL
      AND "source_answer_sha256" IS NOT NULL
      AND "source_answer_sha256" ~ '^[0-9a-f]{64}$'
    )
  );

ALTER TABLE "agent_outcome_observations"
  ADD CONSTRAINT "agent_outcome_observations_source_question_scope_fkey"
  FOREIGN KEY ("source_question_id", "tenant_id", "venue_id")
  REFERENCES "agent_questions"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
