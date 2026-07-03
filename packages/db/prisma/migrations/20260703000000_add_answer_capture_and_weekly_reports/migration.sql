-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "WeeklyReportStatus" AS ENUM ('GENERATING', 'DRAFT', 'PUBLISHED', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "AnswerAnalysisStatus" AS ENUM ('GENERATING', 'COMPLETE', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "visitor_sessions" ADD COLUMN "pending_engagement_question_id" TEXT;
ALTER TABLE "visitor_sessions" ADD COLUMN "pending_engagement_is_invented" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "visitor_sessions" ADD COLUMN "pending_engagement_asked_message_id" TEXT;
ALTER TABLE "visitor_sessions" ADD COLUMN "pending_engagement_asked_at" TIMESTAMP(3);
ALTER TABLE "visitor_sessions" ADD COLUMN "is_notable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "engagement_question_responses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "engagement_question_id" TEXT,
    "is_ai_invented" BOOLEAN NOT NULL DEFAULT false,
    "answer_type" "EngagementQuestionType" NOT NULL,
    "question_text" TEXT NOT NULL,
    "asked_message_id" TEXT NOT NULL,
    "answer_message_id" TEXT NOT NULL,
    "answer_text" TEXT NOT NULL,
    "asked_at" TIMESTAMP(3) NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "sentiment_label" TEXT,
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engagement_question_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_chatlog_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_chatlog_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "week_start" TIMESTAMP(3) NOT NULL,
    "week_end" TIMESTAMP(3) NOT NULL,
    "status" "WeeklyReportStatus" NOT NULL DEFAULT 'GENERATING',
    "title" TEXT NOT NULL DEFAULT 'PathFinder Weekly Report',
    "content" TEXT,
    "answer_count" INTEGER NOT NULL DEFAULT 0,
    "session_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "generated_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_analysis_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "status" "AnswerAnalysisStatus" NOT NULL DEFAULT 'GENERATING',
    "summary" JSONB,
    "answer_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "generated_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_analysis_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visitor_sessions_tenant_id_venue_id_started_at_idx" ON "visitor_sessions"("tenant_id", "venue_id", "started_at");

-- CreateIndex
CREATE INDEX "engagement_question_responses_tenant_id_venue_id_answered_at_idx" ON "engagement_question_responses"("tenant_id", "venue_id", "answered_at");

-- CreateIndex
CREATE INDEX "engagement_question_responses_engagement_question_id_idx" ON "engagement_question_responses"("engagement_question_id");

-- CreateIndex
CREATE INDEX "engagement_question_responses_session_id_idx" ON "engagement_question_responses"("session_id");

-- CreateIndex
CREATE INDEX "admin_chatlog_notes_tenant_id_session_id_idx" ON "admin_chatlog_notes"("tenant_id", "session_id");

-- CreateIndex
CREATE INDEX "admin_chatlog_notes_venue_id_created_at_idx" ON "admin_chatlog_notes"("venue_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reports_venue_id_week_start_key" ON "weekly_reports"("venue_id", "week_start");

-- CreateIndex
CREATE INDEX "weekly_reports_tenant_id_venue_id_week_start_idx" ON "weekly_reports"("tenant_id", "venue_id", "week_start");

-- CreateIndex
CREATE INDEX "weekly_reports_status_idx" ON "weekly_reports"("status");

-- CreateIndex
CREATE INDEX "answer_analysis_snapshots_tenant_id_venue_id_created_at_idx" ON "answer_analysis_snapshots"("tenant_id", "venue_id", "created_at");

-- AddForeignKey
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_question_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_question_responses_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_question_responses_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "visitor_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_question_responses" ADD CONSTRAINT "engagement_question_responses_engagement_question_id_fkey" FOREIGN KEY ("engagement_question_id") REFERENCES "engagement_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_chatlog_notes" ADD CONSTRAINT "admin_chatlog_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_chatlog_notes" ADD CONSTRAINT "admin_chatlog_notes_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_chatlog_notes" ADD CONSTRAINT "admin_chatlog_notes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "visitor_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_analysis_snapshots" ADD CONSTRAINT "answer_analysis_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_analysis_snapshots" ADD CONSTRAINT "answer_analysis_snapshots_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
