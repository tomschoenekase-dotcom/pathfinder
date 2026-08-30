CREATE TYPE "PublicInterestSubmissionStatus" AS ENUM ('NEW', 'REVIEWED', 'ARCHIVED');
CREATE TYPE "PublicInterestReviewDecision" AS ENUM ('MARK_REVIEWED', 'ARCHIVE', 'REOPEN');

CREATE TABLE "public_interest_submissions" (
    "id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "organization_name" VARCHAR(160) NOT NULL,
    "contact_name" VARCHAR(120) NOT NULL,
    "work_email" VARCHAR(320) NOT NULL,
    "normalized_email" VARCHAR(320) NOT NULL,
    "website" VARCHAR(1000),
    "city_region" VARCHAR(200),
    "venue_type" VARCHAR(100),
    "message" VARCHAR(2000),
    "source_path" VARCHAR(200) NOT NULL DEFAULT '/request-demo',
    "status" "PublicInterestSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" VARCHAR(191),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "public_interest_submissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public_interest_submission_reviews" (
    "id" TEXT NOT NULL,
    "operation_id" UUID NOT NULL,
    "operation_hash" CHAR(64) NOT NULL,
    "submission_id" TEXT NOT NULL,
    "decision" "PublicInterestReviewDecision" NOT NULL,
    "reason" VARCHAR(1000),
    "reviewer_id" VARCHAR(191) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "public_interest_submission_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_interest_submissions_request_id_key" ON "public_interest_submissions"("request_id");
CREATE INDEX "public_interest_submissions_status_created_idx" ON "public_interest_submissions"("status", "created_at", "id");
CREATE INDEX "public_interest_submissions_email_created_idx" ON "public_interest_submissions"("normalized_email", "created_at");
CREATE UNIQUE INDEX "public_interest_submission_reviews_operation_id_key" ON "public_interest_submission_reviews"("operation_id");
CREATE INDEX "public_interest_reviews_submission_created_idx" ON "public_interest_submission_reviews"("submission_id", "created_at", "id");

ALTER TABLE "public_interest_submission_reviews"
  ADD CONSTRAINT "public_interest_submission_reviews_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "public_interest_submissions"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_public_interest_submission_evidence"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."organization_name" IS DISTINCT FROM OLD."organization_name"
     OR NEW."contact_name" IS DISTINCT FROM OLD."contact_name"
     OR NEW."work_email" IS DISTINCT FROM OLD."work_email"
     OR NEW."normalized_email" IS DISTINCT FROM OLD."normalized_email"
     OR NEW."website" IS DISTINCT FROM OLD."website"
     OR NEW."city_region" IS DISTINCT FROM OLD."city_region"
     OR NEW."venue_type" IS DISTINCT FROM OLD."venue_type"
     OR NEW."message" IS DISTINCT FROM OLD."message"
     OR NEW."source_path" IS DISTINCT FROM OLD."source_path"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'public interest submission evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "public_interest_submission_evidence_guard"
  BEFORE UPDATE ON "public_interest_submissions"
  FOR EACH ROW EXECUTE FUNCTION "guard_public_interest_submission_evidence"();

CREATE FUNCTION "reject_public_interest_review_mutation"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'public interest review history is append-only';
END;
$$;

CREATE TRIGGER "public_interest_review_update_guard"
  BEFORE UPDATE ON "public_interest_submission_reviews"
  FOR EACH ROW EXECUTE FUNCTION "reject_public_interest_review_mutation"();

CREATE TRIGGER "public_interest_review_delete_guard"
  BEFORE DELETE ON "public_interest_submission_reviews"
  FOR EACH ROW EXECUTE FUNCTION "reject_public_interest_review_mutation"();
