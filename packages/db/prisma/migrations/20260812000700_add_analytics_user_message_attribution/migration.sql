-- Analytics question attribution must point to durable, exactly scoped user-message
-- evidence. Legacy events did not persist a durable message identifier; timestamps,
-- lengths, and metadata are not unique evidence, so they remain truthfully unattributed.
BEGIN;

ALTER TABLE "analytics_events"
  ADD COLUMN "user_message_id" TEXT;

CREATE INDEX "analytics_events_user_message_scope_idx"
  ON "analytics_events"("user_message_id", "tenant_id", "venue_id", "session_id");

ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_events_user_message_scope_fkey"
  FOREIGN KEY ("user_message_id", "tenant_id", "venue_id", "session_id")
  REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id")
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;

CREATE FUNCTION pathfinder_guard_analytics_event_user_message()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."user_message_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public."messages" AS message
    WHERE message."id" = NEW."user_message_id"
      AND message."tenant_id" = NEW."tenant_id"
      AND message."venue_id" = NEW."venue_id"
      AND message."session_id" = NEW."session_id"
      AND message."role" = 'user'
  ) THEN
    RAISE EXCEPTION 'analytics event user-message attribution is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analytics_events_user_message_guard
  BEFORE INSERT OR UPDATE OF "user_message_id", "tenant_id", "venue_id", "session_id"
  ON "analytics_events"
  FOR EACH ROW
  EXECUTE FUNCTION pathfinder_guard_analytics_event_user_message();

COMMIT;
