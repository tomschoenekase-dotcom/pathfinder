CREATE TYPE "MessageFeedbackRating" AS ENUM ('HELPFUL', 'NOT_HELPFUL');

CREATE TABLE "message_feedback" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "rating" "MessageFeedbackRating" NOT NULL,
  "reason" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "message_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_feedback_tenant_id_venue_id_session_id_message_id_key"
  ON "message_feedback"("tenant_id", "venue_id", "session_id", "message_id");
CREATE INDEX "message_feedback_tenant_id_venue_id_rating_created_at_idx"
  ON "message_feedback"("tenant_id", "venue_id", "rating", "created_at");

ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_venue_id_tenant_id_fkey"
  FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_session_id_tenant_id_venue_id_fkey"
  FOREIGN KEY ("session_id", "tenant_id", "venue_id") REFERENCES "visitor_sessions"("id", "tenant_id", "venue_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_message_id_tenant_id_venue_id_session_id_fkey"
  FOREIGN KEY ("message_id", "tenant_id", "venue_id", "session_id") REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
