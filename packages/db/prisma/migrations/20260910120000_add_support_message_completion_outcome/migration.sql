ALTER TABLE "support_messages"
  ADD COLUMN "completion_outcome" VARCHAR(24);

ALTER TABLE "support_messages"
  ADD CONSTRAINT "support_messages_completion_outcome_shape_check"
  CHECK (
    "completion_outcome" IS NULL
    OR (
      "completion_outcome" IN ('UPDATED', 'NO_CHANGE', 'MIXED', 'RESOLVED')
      AND "visibility" = 'CLIENT_VISIBLE'
      AND "request_version" IS NOT NULL
    )
  );
