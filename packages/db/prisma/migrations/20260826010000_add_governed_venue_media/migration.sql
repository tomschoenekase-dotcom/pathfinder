CREATE TYPE "VenueMediaKind" AS ENUM ('IMAGE');
CREATE TYPE "VenueMediaImportance" AS ENUM ('PRIMARY', 'SECONDARY');
CREATE TYPE "VenueMediaReviewAction" AS ENUM ('APPROVE_CONTENT_USE', 'WITHDRAW_CONTENT_USE');
CREATE TYPE "VenueMediaRightsBasis" AS ENUM (
  'VENUE_OWNED',
  'LICENSED',
  'PERMISSION_GRANTED',
  'PUBLIC_DOMAIN'
);

CREATE TABLE "venue_media_assets" (
  "id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "intake_upload_id" TEXT NOT NULL,
  "kind" "VenueMediaKind" NOT NULL,
  "semantic_description" TEXT NOT NULL,
  "depicted_subjects" TEXT[] NOT NULL,
  "alt_text" VARCHAR(240) NOT NULL,
  "caption" VARCHAR(300),
  "usage_guidance" TEXT,
  "importance" "VenueMediaImportance" NOT NULL DEFAULT 'SECONDARY',
  "source_name" VARCHAR(500) NOT NULL,
  "source_url" VARCHAR(2000),
  "source_captured_at" TIMESTAMP(3),
  "created_by" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "venue_media_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_media_assets_semantic_description_not_blank"
    CHECK (length(btrim("semantic_description")) > 0),
  CONSTRAINT "venue_media_assets_alt_text_not_blank" CHECK (length(btrim("alt_text")) > 0),
  CONSTRAINT "venue_media_assets_source_name_not_blank" CHECK (length(btrim("source_name")) > 0)
);

CREATE TABLE "venue_media_place_links" (
  "asset_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "place_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "venue_media_place_links_pkey" PRIMARY KEY ("asset_id", "place_id")
);

CREATE TABLE "venue_media_knowledge_links" (
  "asset_id" UUID NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "knowledge_entry_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "venue_media_knowledge_links_pkey" PRIMARY KEY ("asset_id", "knowledge_entry_id")
);

CREATE TABLE "venue_media_reviews" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "asset_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "action" "VenueMediaReviewAction" NOT NULL,
  "rights_basis" "VenueMediaRightsBasis",
  "rights_statement" TEXT,
  "rights_evidence_source_id" VARCHAR(500),
  "reason" TEXT,
  "request_id" UUID NOT NULL,
  "actor_id" VARCHAR(191) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "venue_media_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_media_reviews_sequence_positive" CHECK ("sequence" > 0),
  CONSTRAINT "venue_media_reviews_action_evidence_complete" CHECK (
    (
      "action" = 'APPROVE_CONTENT_USE'
      AND "rights_basis" IS NOT NULL
      AND length(btrim("rights_statement")) > 0
      AND length(btrim("rights_evidence_source_id")) > 0
      AND "reason" IS NULL
    )
    OR
    (
      "action" = 'WITHDRAW_CONTENT_USE'
      AND "rights_basis" IS NULL
      AND "rights_statement" IS NULL
      AND "rights_evidence_source_id" IS NULL
      AND length(btrim("reason")) > 0
    )
  )
);

CREATE UNIQUE INDEX "venue_media_assets_intake_upload_id_key"
  ON "venue_media_assets"("intake_upload_id");
CREATE UNIQUE INDEX "venue_media_assets_scope_key"
  ON "venue_media_assets"("id", "tenant_id", "venue_id");
CREATE UNIQUE INDEX "venue_media_assets_upload_scope_key"
  ON "venue_media_assets"("intake_upload_id", "tenant_id", "venue_id");
CREATE INDEX "venue_media_assets_scope_created_idx"
  ON "venue_media_assets"("tenant_id", "venue_id", "created_at");
CREATE INDEX "venue_media_place_links_scope_idx"
  ON "venue_media_place_links"("tenant_id", "venue_id", "place_id");
CREATE INDEX "venue_media_knowledge_links_scope_idx"
  ON "venue_media_knowledge_links"("tenant_id", "venue_id", "knowledge_entry_id");
CREATE UNIQUE INDEX "venue_media_reviews_asset_sequence_key"
  ON "venue_media_reviews"("asset_id", "sequence");
CREATE UNIQUE INDEX "venue_media_reviews_tenant_request_key"
  ON "venue_media_reviews"("tenant_id", "request_id");
CREATE INDEX "venue_media_reviews_scope_idx"
  ON "venue_media_reviews"("tenant_id", "venue_id", "asset_id", "sequence");

ALTER TABLE "venue_media_assets"
  ADD CONSTRAINT "venue_media_assets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_media_assets"
  ADD CONSTRAINT "venue_media_assets_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_media_assets"
  ADD CONSTRAINT "venue_media_assets_intake_upload_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("intake_upload_id", "tenant_id", "venue_id")
  REFERENCES "intake_uploads"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_media_place_links"
  ADD CONSTRAINT "venue_media_place_links_asset_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("asset_id", "tenant_id", "venue_id")
  REFERENCES "venue_media_assets"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_media_place_links"
  ADD CONSTRAINT "venue_media_place_links_place_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("place_id", "tenant_id", "venue_id")
  REFERENCES "places"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_media_knowledge_links"
  ADD CONSTRAINT "venue_media_knowledge_links_asset_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("asset_id", "tenant_id", "venue_id")
  REFERENCES "venue_media_assets"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "venue_media_knowledge_links"
  ADD CONSTRAINT "venue_media_knowledge_links_knowledge_entry_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("knowledge_entry_id", "tenant_id", "venue_id")
  REFERENCES "venue_knowledge_entries"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "venue_media_reviews"
  ADD CONSTRAINT "venue_media_reviews_asset_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("asset_id", "tenant_id", "venue_id")
  REFERENCES "venue_media_assets"("id", "tenant_id", "venue_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
