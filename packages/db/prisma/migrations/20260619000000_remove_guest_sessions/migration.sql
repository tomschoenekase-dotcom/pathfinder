ALTER TABLE "visitor_sessions"
  ADD COLUMN "message_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "visitor_sessions" AS vs
SET
  "message_count" = gs."message_count",
  "last_active_at" = GREATEST(vs."last_active_at", gs."last_seen_at")
FROM "guest_sessions" AS gs
WHERE vs."anonymous_token" = gs."id"
  AND vs."tenant_id" = gs."tenant_id";

DROP TABLE "guest_sessions";
