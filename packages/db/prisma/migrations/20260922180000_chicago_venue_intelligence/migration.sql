-- CreateTable
CREATE TABLE "prospect_venue_intelligence" (
    "venue_id" TEXT NOT NULL,
    "identity_key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "territory_name" TEXT NOT NULL DEFAULT 'Chicago Metro',
    "confidence" TEXT NOT NULL DEFAULT 'unknown',
    "fields" JSONB NOT NULL DEFAULT '{}',
    "contact_claims" JSONB NOT NULL DEFAULT '[]',
    "ranking_input" JSONB NOT NULL DEFAULT '{}',
    "ranking_snapshot" JSONB NOT NULL DEFAULT '{}',
    "ranking_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_venue_intelligence_pkey" PRIMARY KEY ("venue_id")
);

-- CreateTable
CREATE TABLE "prospect_venue_rankings" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "as_of" VARCHAR(10) NOT NULL,
    "input" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_venue_rankings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_intelligence_receipts" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "venue_id" TEXT,
    "before_state" JSONB NOT NULL,
    "after_state" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_intelligence_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_intelligence_reviews" (
    "id" TEXT NOT NULL,
    "venue_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "original" JSONB NOT NULL,
    "source_hash" TEXT,
    "decision" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_intelligence_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prospect_venue_intelligence_identity_key_key" ON "prospect_venue_intelligence"("identity_key");

-- CreateIndex
CREATE INDEX "prospect_venue_intelligence_territory_name_updated_at_idx" ON "prospect_venue_intelligence"("territory_name", "updated_at");

-- CreateIndex
CREATE INDEX "prospect_venue_rankings_venue_id_created_at_idx" ON "prospect_venue_rankings"("venue_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_venue_rankings_venue_id_version_input_hash_as_of_key" ON "prospect_venue_rankings"("venue_id", "version", "input_hash", "as_of");

-- CreateIndex
CREATE INDEX "prospect_intelligence_receipts_venue_id_created_at_idx" ON "prospect_intelligence_receipts"("venue_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_intelligence_receipts_actor_id_run_id_idempotency__key" ON "prospect_intelligence_receipts"("actor_id", "run_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "prospect_intelligence_reviews_status_kind_created_at_idx" ON "prospect_intelligence_reviews"("status", "kind", "created_at");

-- CreateIndex
CREATE INDEX "prospect_intelligence_reviews_venue_id_status_idx" ON "prospect_intelligence_reviews"("venue_id", "status");

-- AddForeignKey
ALTER TABLE "prospect_venue_intelligence" ADD CONSTRAINT "prospect_venue_intelligence_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_venue_rankings" ADD CONSTRAINT "prospect_venue_rankings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_intelligence_reviews" ADD CONSTRAINT "prospect_intelligence_reviews_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "prospect_venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
