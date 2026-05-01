-- Migration 007: venue branding & AI guide name
-- Adds custom AI guide name, chat theme, accent colour, logo URL, and banner URL to venues.

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS ai_guide_name TEXT,
  ADD COLUMN IF NOT EXISTS chat_theme TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS chat_accent_color TEXT,
  ADD COLUMN IF NOT EXISTS chat_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS chat_banner_url TEXT;
