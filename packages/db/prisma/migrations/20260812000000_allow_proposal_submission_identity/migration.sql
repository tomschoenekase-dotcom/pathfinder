BEGIN;

ALTER TABLE "intake_runs" DROP CONSTRAINT "intake_runs_source_shape_check";
ALTER TABLE "intake_runs" ADD CONSTRAINT "intake_runs_source_shape_check" CHECK (
  ("source_kind" = 'WEBSITE' AND "website_uri" IS NOT NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL AND "structured_bootstrap" IS NULL AND (("submission_request_id" IS NULL AND "submission_input_hash" IS NULL) OR ("submission_request_id" IS NOT NULL AND "submission_input_hash" ~ '^[a-f0-9]{64}$'))) OR
  ("source_kind" = 'INTERVIEW' AND "website_uri" IS NULL AND "interview_role" IN ('EXECUTIVE', 'VISITOR_SERVICES', 'OPERATIONS', 'ACCESSIBILITY', 'CONTENT') AND "interview_public_answers" IS NOT NULL AND "interview_answer_manifest" IS NOT NULL AND "interview_consent_text_hash" ~ '^[a-f0-9]{64}$' AND "structured_bootstrap" IS NULL AND (("submission_request_id" IS NULL AND "submission_input_hash" IS NULL) OR ("submission_request_id" IS NOT NULL AND "submission_input_hash" ~ '^[a-f0-9]{64}$'))) OR
  ("source_kind" = 'STRUCTURED_BOOTSTRAP' AND "website_uri" IS NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL AND jsonb_typeof("structured_bootstrap") = 'object' AND "submission_request_id" IS NOT NULL AND "submission_input_hash" ~ '^[a-f0-9]{64}$') OR
  ("source_kind" = 'FILE_UPLOAD' AND "website_uri" IS NULL AND "interview_role" IS NULL AND "interview_public_answers" IS NULL AND "interview_answer_manifest" IS NULL AND "interview_consent_text_hash" IS NULL AND "structured_bootstrap" IS NULL AND "submission_request_id" IS NULL AND "submission_input_hash" IS NULL)
);

COMMIT;
