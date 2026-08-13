-- Forward-only verification state. Existing uploads are intentionally not
-- inferred or backfilled; legacy AWAITING_REVIEW rows retain unknown scan truth.
-- PostgreSQL requires this enum addition to commit before the next migration
-- can reference PRECHECK_PASSED in table constraints and trigger functions.
ALTER TYPE "IntakeUploadStatus" ADD VALUE 'PRECHECK_PASSED' BEFORE 'AWAITING_REVIEW';
