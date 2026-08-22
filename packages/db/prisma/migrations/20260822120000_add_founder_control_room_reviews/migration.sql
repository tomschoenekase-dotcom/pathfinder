CREATE TABLE "founder_control_room_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "operator_user_id" VARCHAR(191) NOT NULL,
  "reviewed_through" TIMESTAMP(3) NOT NULL,
  "previous_reviewed_through" TIMESTAMP(3),
  "briefing_schema_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "founder_control_room_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "founder_control_room_reviews_cursor_progression_check"
    CHECK (
      ("previous_reviewed_through" IS NULL OR "reviewed_through" > "previous_reviewed_through")
      AND "reviewed_through" <= "created_at" + INTERVAL '5 minutes'
      AND "briefing_schema_version" > 0
    )
);

CREATE UNIQUE INDEX "founder_control_room_reviews_operation_id_key"
  ON "founder_control_room_reviews"("operation_id");

CREATE INDEX "founder_control_room_reviews_operator_cursor_idx"
  ON "founder_control_room_reviews"("operator_user_id", "reviewed_through", "created_at");

CREATE UNIQUE INDEX "founder_control_room_reviews_transition_key"
  ON "founder_control_room_reviews"("operator_user_id", "previous_reviewed_through") NULLS NOT DISTINCT;

CREATE TRIGGER "founder_control_room_reviews_append_only_update_delete"
  BEFORE UPDATE OR DELETE ON "founder_control_room_reviews"
  FOR EACH ROW EXECUTE FUNCTION pathfinder_reject_append_only_mutation();

CREATE TRIGGER "founder_control_room_reviews_append_only_truncate"
  BEFORE TRUNCATE ON "founder_control_room_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION pathfinder_reject_append_only_mutation();
