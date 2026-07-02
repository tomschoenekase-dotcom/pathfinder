-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "EngagementQuestionType" AS ENUM ('OPEN_ENDED', 'MULTIPLE_CHOICE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "TenantEngagementMode" AS ENUM ('STOIC', 'BALANCED', 'CURIOUS');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "engagement_mode" "TenantEngagementMode" NOT NULL DEFAULT 'STOIC';

-- CreateTable
CREATE TABLE "engagement_questions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "question_type" "EngagementQuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "choice_options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "intensity" INTEGER NOT NULL DEFAULT 3,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "engagement_questions_tenant_id_idx" ON "engagement_questions"("tenant_id");

-- AddForeignKey
ALTER TABLE "engagement_questions" ADD CONSTRAINT "engagement_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
