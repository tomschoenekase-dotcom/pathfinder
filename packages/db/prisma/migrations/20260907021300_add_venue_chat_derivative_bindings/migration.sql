-- Bind client branding to reviewed, controlled derivatives by identity.
-- Legacy URL fields remain for compatibility; new writes must use these IDs.
BEGIN;

ALTER TABLE "venues"
  ADD COLUMN "chat_logo_derivative_id" UUID,
  ADD COLUMN "chat_banner_derivative_id" UUID,
  ADD COLUMN "chat_logo_derivative_receipt" JSONB,
  ADD COLUMN "chat_banner_derivative_receipt" JSONB;

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_chat_logo_derivative_receipt_pair"
    CHECK (("chat_logo_derivative_id" IS NULL) = ("chat_logo_derivative_receipt" IS NULL)),
  ADD CONSTRAINT "venues_chat_banner_derivative_receipt_pair"
    CHECK (("chat_banner_derivative_id" IS NULL) = ("chat_banner_derivative_receipt" IS NULL)),
  ADD CONSTRAINT "venues_chat_logo_derivative_receipt_shape"
    CHECK ("chat_logo_derivative_receipt" IS NULL OR (
      jsonb_typeof("chat_logo_derivative_receipt") = 'object' AND
      "chat_logo_derivative_receipt" ?& ARRAY['assetId', 'derivativeId', 'sourceObjectGeneration', 'sha256', 'approvedReviewSequence'] AND
      "chat_logo_derivative_receipt" - ARRAY['assetId', 'derivativeId', 'sourceObjectGeneration', 'sha256', 'approvedReviewSequence'] = '{}'::jsonb AND
      jsonb_typeof("chat_logo_derivative_receipt"->'assetId') = 'string' AND
      ("chat_logo_derivative_receipt"->>'assetId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      jsonb_typeof("chat_logo_derivative_receipt"->'derivativeId') = 'string' AND
      "chat_logo_derivative_receipt"->>'derivativeId' = "chat_logo_derivative_id"::text AND
      jsonb_typeof("chat_logo_derivative_receipt"->'sourceObjectGeneration') = 'string' AND
      ("chat_logo_derivative_receipt"->>'sourceObjectGeneration') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      jsonb_typeof("chat_logo_derivative_receipt"->'sha256') = 'string' AND
      ("chat_logo_derivative_receipt"->>'sha256') ~ '^[0-9a-f]{64}$' AND
      jsonb_typeof("chat_logo_derivative_receipt"->'approvedReviewSequence') = 'number' AND
      ("chat_logo_derivative_receipt"->>'approvedReviewSequence') ~ '^[1-9][0-9]{0,9}$'
    )),
  ADD CONSTRAINT "venues_chat_banner_derivative_receipt_shape"
    CHECK ("chat_banner_derivative_receipt" IS NULL OR (
      jsonb_typeof("chat_banner_derivative_receipt") = 'object' AND
      "chat_banner_derivative_receipt" ?& ARRAY['assetId', 'derivativeId', 'sourceObjectGeneration', 'sha256', 'approvedReviewSequence'] AND
      "chat_banner_derivative_receipt" - ARRAY['assetId', 'derivativeId', 'sourceObjectGeneration', 'sha256', 'approvedReviewSequence'] = '{}'::jsonb AND
      jsonb_typeof("chat_banner_derivative_receipt"->'assetId') = 'string' AND
      ("chat_banner_derivative_receipt"->>'assetId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      jsonb_typeof("chat_banner_derivative_receipt"->'derivativeId') = 'string' AND
      "chat_banner_derivative_receipt"->>'derivativeId' = "chat_banner_derivative_id"::text AND
      jsonb_typeof("chat_banner_derivative_receipt"->'sourceObjectGeneration') = 'string' AND
      ("chat_banner_derivative_receipt"->>'sourceObjectGeneration') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      jsonb_typeof("chat_banner_derivative_receipt"->'sha256') = 'string' AND
      ("chat_banner_derivative_receipt"->>'sha256') ~ '^[0-9a-f]{64}$' AND
      jsonb_typeof("chat_banner_derivative_receipt"->'approvedReviewSequence') = 'number' AND
      ("chat_banner_derivative_receipt"->>'approvedReviewSequence') ~ '^[1-9][0-9]{0,9}$'
    ));

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_chat_logo_derivative_fk"
    FOREIGN KEY ("chat_logo_derivative_id", "tenant_id", "id")
    REFERENCES "venue_media_derivatives" ("id", "tenant_id", "venue_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "venues_chat_banner_derivative_fk"
    FOREIGN KEY ("chat_banner_derivative_id", "tenant_id", "id")
    REFERENCES "venue_media_derivatives" ("id", "tenant_id", "venue_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "venues_chat_logo_derivative_idx"
  ON "venues" ("tenant_id", "id", "chat_logo_derivative_id");
CREATE INDEX "venues_chat_banner_derivative_idx"
  ON "venues" ("tenant_id", "id", "chat_banner_derivative_id");

COMMIT;
