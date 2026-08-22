CREATE TYPE "CompanyMeetingEventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELLED');

ALTER TYPE "CorrespondenceCapability" ADD VALUE 'CALENDAR_READ';
ALTER TYPE "CorrespondenceCapability" ADD VALUE 'MEET_TRANSCRIPTS';

DROP INDEX "company_meetings_provider_external_key";

ALTER TABLE "company_meetings"
  ADD COLUMN "provider_account_id" TEXT,
  ADD COLUMN "calendar_id" VARCHAR(512),
  ADD COLUMN "ical_uid" VARCHAR(1024),
  ADD COLUMN "recurring_event_id" VARCHAR(1024),
  ADD COLUMN "original_start_at" TIMESTAMP(3),
  ADD COLUMN "event_status" "CompanyMeetingEventStatus",
  ADD COLUMN "event_time_zone" VARCHAR(100),
  ADD COLUMN "organizer_email" VARCHAR(320),
  ADD COLUMN "provider_updated_at" TIMESTAMP(3),
  ADD COLUMN "event_sequence" INTEGER;

ALTER TABLE "company_meetings" ALTER COLUMN "external_id" TYPE VARCHAR(1024);

ALTER TABLE "company_meeting_participants"
  ADD COLUMN "email" VARCHAR(320),
  ADD COLUMN "response_status" VARCHAR(64),
  ADD COLUMN "is_organizer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_self" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "google_calendar_sync_states" (
  "id" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "calendar_id" VARCHAR(512) NOT NULL,
  "sync_cursor" VARCHAR(2000) NOT NULL,
  "last_successful_sync_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "google_calendar_sync_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_meeting_transcript_artifacts" (
  "id" TEXT NOT NULL,
  "meeting_id" TEXT NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "conference_record_name" VARCHAR(1000) NOT NULL,
  "transcript_name" VARCHAR(1000) NOT NULL,
  "source_reference" VARCHAR(1000) NOT NULL,
  "transcript_text" TEXT NOT NULL,
  "structured_entries" JSONB NOT NULL DEFAULT '[]',
  "acquired_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "company_meeting_transcript_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "company_meeting_transcript_artifacts_one_year_check" CHECK ("expires_at" = "acquired_at" + INTERVAL '365 days')
);

CREATE INDEX "company_meetings_provider_external_idx" ON "company_meetings"("external_provider", "external_id");
CREATE UNIQUE INDEX "company_meetings_account_calendar_external_key" ON "company_meetings"("provider_account_id", "calendar_id", "external_id");
CREATE UNIQUE INDEX "google_calendar_sync_states_account_calendar_key" ON "google_calendar_sync_states"("provider_account_id", "calendar_id");
CREATE INDEX "google_calendar_sync_states_last_success_idx" ON "google_calendar_sync_states"("last_successful_sync_at");
CREATE UNIQUE INDEX "company_meeting_transcripts_account_name_key" ON "company_meeting_transcript_artifacts"("provider_account_id", "transcript_name");
CREATE INDEX "company_meeting_transcripts_meeting_expiry_idx" ON "company_meeting_transcript_artifacts"("meeting_id", "expires_at");
CREATE INDEX "company_meeting_transcripts_expiry_idx" ON "company_meeting_transcript_artifacts"("expires_at");

ALTER TABLE "google_calendar_sync_states" ADD CONSTRAINT "google_calendar_sync_states_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "company_meetings" ADD CONSTRAINT "company_meetings_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "company_meeting_transcript_artifacts" ADD CONSTRAINT "company_meeting_transcript_artifacts_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "company_meetings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "company_meeting_transcript_artifacts" ADD CONSTRAINT "company_meeting_transcript_artifacts_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "correspondence_provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
