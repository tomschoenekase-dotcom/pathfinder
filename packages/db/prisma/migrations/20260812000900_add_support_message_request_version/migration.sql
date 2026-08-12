BEGIN;

-- Legacy messages remain nullable because their exact produced global request
-- version was not durably recorded and must not be guessed during migration.
ALTER TABLE "support_messages"
  ADD COLUMN "request_version" INTEGER;

-- Version evidence is valid only as part of the immutable submission identity.
-- Manual-loop replay additionally fails closed when this evidence is absent.
ALTER TABLE "support_messages"
  ADD CONSTRAINT "support_messages_request_version_evidence_check"
  CHECK (
    "request_version" IS NULL
    OR (
      "request_version" > 0
      AND "submission_request_id" IS NOT NULL
      AND "submission_input_hash" IS NOT NULL
    )
  );

COMMIT;
