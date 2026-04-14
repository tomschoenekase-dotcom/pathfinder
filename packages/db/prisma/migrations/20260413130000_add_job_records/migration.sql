-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('RUNNING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "job_records" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "bull_job_id" TEXT,
    "tenant_id" TEXT,
    "status" "JobStatus" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_records_bull_job_id_key" ON "job_records"("bull_job_id");

-- CreateIndex
CREATE INDEX "job_records_queue_status_idx" ON "job_records"("queue", "status");

-- CreateIndex
CREATE INDEX "job_records_tenant_id_created_at_idx" ON "job_records"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "job_records_created_at_idx" ON "job_records"("created_at");
