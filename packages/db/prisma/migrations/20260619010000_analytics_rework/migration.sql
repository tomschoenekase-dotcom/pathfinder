-- Persistent per-browser visitor identity (localStorage), distinct from the
-- per-visit anonymous_token. Drives unique/returning visitor analytics.
ALTER TABLE "visitor_sessions"
  ADD COLUMN "visitor_id" TEXT;

CREATE INDEX "visitor_sessions_visitor_id_idx" ON "visitor_sessions"("visitor_id");

-- Nightly-filled fixed-taxonomy topic label for guest questions.
ALTER TABLE "messages"
  ADD COLUMN "topic" TEXT;

CREATE INDEX "messages_topic_idx" ON "messages"("topic");

-- Question clusters (top questions + content gaps) per venue/window.
CREATE TABLE "question_clusters" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "venue_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "window_start" TIMESTAMP(3) NOT NULL,
  "window_end" TIMESTAMP(3) NOT NULL,
  "canonical_text" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "examples" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "question_clusters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "question_clusters_tenant_id_venue_id_kind_window_start_idx"
  ON "question_clusters"("tenant_id", "venue_id", "kind", "window_start");

ALTER TABLE "question_clusters"
  ADD CONSTRAINT "question_clusters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "question_clusters"
  ADD CONSTRAINT "question_clusters_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
