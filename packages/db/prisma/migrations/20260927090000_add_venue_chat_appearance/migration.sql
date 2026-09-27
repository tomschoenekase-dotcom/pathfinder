-- Venue-chosen visitor chat appearance (bubbles, colors, background image placement).
-- Nullable with no backfill: existing venues keep the default plain presentation.
ALTER TABLE "venues" ADD COLUMN "chat_appearance" JSONB;
