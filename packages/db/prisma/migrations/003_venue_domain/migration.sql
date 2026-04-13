-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "venues" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "default_center_lat" DOUBLE PRECISION,
    "default_center_lng" DOUBLE PRECISION,
    "geo_boundary" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "places" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "short_description" TEXT,
    "long_description" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "tags" TEXT[],
    "importance_score" INTEGER NOT NULL DEFAULT 0,
    "area_name" TEXT,
    "hours" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "anonymous_token" TEXT NOT NULL,
    "latest_lat" DOUBLE PRECISION,
    "latest_lng" DOUBLE PRECISION,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_adapters" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "adapter_type" TEXT NOT NULL,
    "config_blob" JSONB NOT NULL DEFAULT '{}',
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_adapters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "venues_tenant_id_slug_key" ON "venues"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "venues_tenant_id_idx" ON "venues"("tenant_id");

-- CreateIndex
CREATE INDEX "places_tenant_id_idx" ON "places"("tenant_id");

-- CreateIndex
CREATE INDEX "places_venue_id_idx" ON "places"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_anonymous_token_key" ON "visitor_sessions"("anonymous_token");

-- CreateIndex
CREATE INDEX "visitor_sessions_tenant_id_idx" ON "visitor_sessions"("tenant_id");

-- CreateIndex
CREATE INDEX "visitor_sessions_venue_id_idx" ON "visitor_sessions"("venue_id");

-- CreateIndex
CREATE INDEX "visitor_sessions_anonymous_token_idx" ON "visitor_sessions"("anonymous_token");

-- CreateIndex
CREATE INDEX "messages_tenant_id_idx" ON "messages"("tenant_id");

-- CreateIndex
CREATE INDEX "messages_session_id_idx" ON "messages"("session_id");

-- CreateIndex
CREATE INDEX "data_adapters_tenant_id_idx" ON "data_adapters"("tenant_id");

-- CreateIndex
CREATE INDEX "data_adapters_venue_id_idx" ON "data_adapters"("venue_id");

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "places" ADD CONSTRAINT "places_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "visitor_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_adapters" ADD CONSTRAINT "data_adapters_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
