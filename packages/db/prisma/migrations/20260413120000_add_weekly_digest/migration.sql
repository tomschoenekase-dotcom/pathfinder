-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "WeeklyDigestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE "weekly_digests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "week_start" TIMESTAMP(3) NOT NULL,
    "week_end" TIMESTAMP(3) NOT NULL,
    "status" "WeeklyDigestStatus" NOT NULL DEFAULT 'PENDING',
    "session_count" INTEGER NOT NULL DEFAULT 0,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "insights" JSONB NOT NULL DEFAULT '[]',
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_digests_tenant_id_week_start_idx" ON "weekly_digests"("tenant_id", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_digests_tenant_id_week_start_key" ON "weekly_digests"("tenant_id", "week_start");

-- AddForeignKey
ALTER TABLE "weekly_digests" ADD CONSTRAINT "weekly_digests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
