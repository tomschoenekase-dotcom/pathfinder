CREATE TYPE "ProspectInboundReplyDisposition" AS ENUM (
  'POSITIVE_INTEREST',
  'QUESTION_OR_OBJECTION',
  'NOT_INTERESTED',
  'SUPPRESSION_REQUEST',
  'OTHER'
);

ALTER TABLE "prospect_email_messages"
  ADD COLUMN "inbound_reply_disposition" "ProspectInboundReplyDisposition",
  ADD COLUMN "inbound_reply_review_id" UUID,
  ADD COLUMN "inbound_reply_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "inbound_reply_reviewer_id" VARCHAR(191),
  ADD CONSTRAINT "prospect_email_messages_reply_review_shape_check" CHECK (
    (
      "inbound_reply_disposition" IS NULL
      AND "inbound_reply_review_id" IS NULL
      AND "inbound_reply_reviewed_at" IS NULL
      AND "inbound_reply_reviewer_id" IS NULL
    ) OR (
      "direction" = 'INBOUND'
      AND "inbound_reply_disposition" IS NOT NULL
      AND "inbound_reply_review_id" IS NOT NULL
      AND "inbound_reply_reviewed_at" IS NOT NULL
      AND length(btrim("inbound_reply_reviewer_id")) BETWEEN 1 AND 191
    )
  );

CREATE TABLE "prospect_inbound_reply_reviews" (
  "id" UUID NOT NULL,
  "operation_id" UUID NOT NULL,
  "message_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "disposition" "ProspectInboundReplyDisposition" NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "reviewer_id" VARCHAR(191) NOT NULL,
  "revision" INTEGER NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_inbound_reply_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_inbound_reply_reviews_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "prospect_inbound_reply_reviews_reason_check" CHECK (
    length(btrim("reason")) BETWEEN 1 AND 2000
  ),
  CONSTRAINT "prospect_inbound_reply_reviews_reviewer_check" CHECK (
    length(btrim("reviewer_id")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "prospect_inbound_reply_reviews_input_hash_check" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "prospect_inbound_reply_reviews_message_fkey"
    FOREIGN KEY ("message_id") REFERENCES "prospect_email_messages"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "prospect_inbound_reply_reviews_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "prospect_organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "prospect_inbound_reply_reviews_operation_id_key"
  ON "prospect_inbound_reply_reviews"("operation_id");
CREATE UNIQUE INDEX "prospect_inbound_reply_reviews_message_revision_key"
  ON "prospect_inbound_reply_reviews"("message_id", "revision");
CREATE INDEX "prospect_inbound_reply_reviews_org_created_idx"
  ON "prospect_inbound_reply_reviews"("organization_id", "created_at", "id");
CREATE INDEX "prospect_inbound_reply_reviews_disposition_created_idx"
  ON "prospect_inbound_reply_reviews"("disposition", "created_at", "id");
CREATE UNIQUE INDEX "prospect_email_messages_inbound_reply_review_id_key"
  ON "prospect_email_messages"("inbound_reply_review_id");
CREATE INDEX "prospect_email_messages_reply_disposition_idx"
  ON "prospect_email_messages"("inbound_reply_disposition", "inbound_reply_reviewed_at");

ALTER TABLE "prospect_email_messages"
  ADD CONSTRAINT "prospect_email_messages_inbound_reply_review_fkey"
  FOREIGN KEY ("inbound_reply_review_id") REFERENCES "prospect_inbound_reply_reviews"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_prospect_inbound_reply_review_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prospect inbound reply reviews are immutable' USING ERRCODE = '55000';
END;
$$;
ALTER FUNCTION "guard_prospect_inbound_reply_review_immutable"() SET search_path = pg_catalog, public;

CREATE TRIGGER "prospect_inbound_reply_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "prospect_inbound_reply_reviews"
  FOR EACH ROW EXECUTE FUNCTION "guard_prospect_inbound_reply_review_immutable"();
CREATE TRIGGER "prospect_inbound_reply_reviews_no_truncate"
  BEFORE TRUNCATE ON "prospect_inbound_reply_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_prospect_inbound_reply_review_immutable"();

CREATE FUNCTION "validate_prospect_inbound_reply_current_review"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  matched_review INTEGER;
BEGIN
  IF NEW."inbound_reply_review_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO matched_review
  FROM "prospect_inbound_reply_reviews" review
  WHERE review."id" = NEW."inbound_reply_review_id"
    AND review."message_id" = NEW."id"
    AND review."organization_id" = NEW."organization_id"
    AND review."disposition" = NEW."inbound_reply_disposition"
    AND review."reviewer_id" = NEW."inbound_reply_reviewer_id"
    AND review."created_at" = NEW."inbound_reply_reviewed_at";

  IF matched_review <> 1 THEN
    RAISE EXCEPTION 'current inbound reply review must match its immutable evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION "validate_prospect_inbound_reply_current_review"() SET search_path = pg_catalog, public;

CREATE CONSTRAINT TRIGGER "prospect_email_messages_current_reply_review_valid"
  AFTER INSERT OR UPDATE OF
    "inbound_reply_disposition",
    "inbound_reply_review_id",
    "inbound_reply_reviewed_at",
    "inbound_reply_reviewer_id"
  ON "prospect_email_messages"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_prospect_inbound_reply_current_review"();
