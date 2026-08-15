BEGIN;

ALTER TABLE "venues"
  ADD COLUMN "second_layer_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "second_layer_label" TEXT NOT NULL DEFAULT 'Employee',
  ADD COLUMN "second_layer_access_key" TEXT;

CREATE UNIQUE INDEX "venues_second_layer_access_key_key"
  ON "venues"("second_layer_access_key");

ALTER TABLE "places"
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE "venue_knowledge_entries"
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE "visitor_sessions"
  ADD COLUMN "experience_scope" TEXT NOT NULL DEFAULT 'PUBLIC';

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_second_layer_configuration_check"
  CHECK (
    ("second_layer_enabled" = false AND "second_layer_access_key" IS NULL)
    OR
    ("second_layer_enabled" = true AND "second_layer_access_key" IS NOT NULL AND char_length("second_layer_label") BETWEEN 1 AND 40)
  );

ALTER TABLE "places"
  ADD CONSTRAINT "places_visibility_check"
  CHECK ("visibility" IN ('PUBLIC', 'SECOND_LAYER'));

ALTER TABLE "venue_knowledge_entries"
  ADD CONSTRAINT "venue_knowledge_entries_visibility_check"
  CHECK ("visibility" IN ('PUBLIC', 'SECOND_LAYER'));

ALTER TABLE "visitor_sessions"
  ADD CONSTRAINT "visitor_sessions_experience_scope_check"
  CHECK ("experience_scope" IN ('PUBLIC', 'SECOND_LAYER'));

COMMIT;
