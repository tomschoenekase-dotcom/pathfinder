-- Existing review rows are historical append-only evidence. Command identity is
-- nullable only for those rows; every new canonical action writes both fields.
ALTER TABLE "eval_reviews"
  ADD COLUMN "submission_operation_id" UUID,
  ADD COLUMN "submission_input_hash" CHAR(64);

ALTER TABLE "eval_reviews"
  ADD CONSTRAINT "eval_reviews_submission_identity_check" CHECK (
    ("submission_operation_id" IS NULL AND "submission_input_hash" IS NULL)
    OR
    ("submission_operation_id" IS NOT NULL AND "submission_input_hash" ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX "eval_reviews_tenant_submission_operation_key"
  ON "eval_reviews"("tenant_id", "submission_operation_id");
