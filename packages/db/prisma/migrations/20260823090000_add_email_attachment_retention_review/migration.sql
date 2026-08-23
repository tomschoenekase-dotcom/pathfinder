CREATE TYPE "ProspectEmailAttachmentRetentionCategory" AS ENUM (
  'CONTRACT_OR_ORDER_FORM',
  'BROCHURE',
  'FLOOR_PLAN_OR_MAP',
  'VENUE_OPERATIONS',
  'CUSTOMER_KNOWLEDGE',
  'GUIDE_MEDIA',
  'OTHER_BUSINESS_RECORD'
);

CREATE TYPE "ProspectEmailAttachmentRetentionStatus" AS ENUM (
  'AWAITING_REVIEW',
  'APPROVED_FOR_IMPORT',
  'DECLINED_SOURCE_ONLY'
);

CREATE TABLE "prospect_email_attachment_retention_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operation_id" UUID NOT NULL,
  "email_message_id" TEXT NOT NULL,
  "provider_attachment_id" VARCHAR(512) NOT NULL,
  "filename" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(255) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "category" "ProspectEmailAttachmentRetentionCategory" NOT NULL,
  "purpose" VARCHAR(2000) NOT NULL,
  "source_reference" VARCHAR(1000),
  "status" "ProspectEmailAttachmentRetentionStatus" NOT NULL DEFAULT 'AWAITING_REVIEW',
  "requested_by_id" VARCHAR(191) NOT NULL,
  "review_operation_id" UUID,
  "reviewed_by_id" VARCHAR(191),
  "review_reason" VARCHAR(2000),
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prospect_email_attachment_retention_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prospect_email_attachment_retention_size_nonnegative" CHECK ("size_bytes" >= 0),
  CONSTRAINT "prospect_email_attachment_retention_review_consistency" CHECK (
    ("status" = 'AWAITING_REVIEW' AND "review_operation_id" IS NULL AND "reviewed_by_id" IS NULL AND "reviewed_at" IS NULL)
    OR
    ("status" <> 'AWAITING_REVIEW' AND "review_operation_id" IS NOT NULL AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "prospect_email_attachment_retention_requests_operation_id_key"
  ON "prospect_email_attachment_retention_requests"("operation_id");
CREATE UNIQUE INDEX "prospect_email_attachment_retention_requests_review_operation_id_key"
  ON "prospect_email_attachment_retention_requests"("review_operation_id");
CREATE UNIQUE INDEX "prospect_email_attachment_retention_one_active_key"
  ON "prospect_email_attachment_retention_requests"("email_message_id", "provider_attachment_id")
  WHERE "status" IN ('AWAITING_REVIEW', 'APPROVED_FOR_IMPORT');
CREATE INDEX "prospect_email_attachment_retention_message_idx"
  ON "prospect_email_attachment_retention_requests"("email_message_id", "created_at", "id");
CREATE INDEX "prospect_email_attachment_retention_review_idx"
  ON "prospect_email_attachment_retention_requests"("status", "created_at", "id");

ALTER TABLE "prospect_email_attachment_retention_requests"
  ADD CONSTRAINT "prospect_email_attachment_retention_message_fkey"
  FOREIGN KEY ("email_message_id") REFERENCES "prospect_email_messages"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
